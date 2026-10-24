// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Ganglion's network (Network.h). The host gives the engine TCP streams (connect, write, close; opened,
// data, closed), nothing more: TLS, HTTP and decoding happen here, so the host and the relay only ever
// carry ciphertext to https sites. HTTP/1.1 written here (docs/network.md says why not libcurl), HTTP/2 through
// nghttp2's framing and HPACK on the same TLS session when the server picks "h2" by ALPN (docs/network.md, "HTTP/2").
//
// Shape: a Request is queued for its origin's pool, in urgency order (RFC 9218, from the fetch's priority and
// destination). A Connection is one TCP stream (plus a TLS session for https). Over HTTP/1.1 it serves one request
// at a time and stays open for the next (keep-alive, at most 6 per origin, as browsers do); over HTTP/2 it carries
// every request of its origin as concurrent streams (up to the server's SETTINGS_MAX_CONCURRENT_STREAMS), and may
// carry another origin's requests when Chrome's pooling rule allows it (the same address and a certificate valid for
// both names). Response bytes are parsed as they arrive and handed to the sink decoded, so a document renders while
// it downloads.
//
// APIs used, as read for this version: OpenSSL 3.6 (SSL_set_bio with memory BIOs, SSL_do_handshake /
// SSL_read_ex / SSL_write_ex and SSL_get_error, SSL_set1_host for the hostname check, PEM_read_bio_X509
// into the context's X509_STORE, SSL_CTX_sess_set_new_cb for session reuse); zlib 1.3 (inflateInit2 with
// 16+MAX_WBITS for gzip, raw retry for servers that send bare deflate, as curl's content_encoding.c does);
// brotli 1.2 (BrotliDecoderDecompressStream); RFC 9112 message framing; nghttp2 1.69 (nghttp2_session_client_new2,
// nghttp2_session_mem_recv2 / nghttp2_session_mem_send2, nghttp2_submit_request2 with a nghttp2_data_provider2,
// nghttp2_submit_settings, nghttp2_submit_rst_stream, nghttp2_session_terminate_session; RFC 9113, HPACK RFC 7541,
// extensible priorities RFC 9218).

#include "Network.h"
#include "EventLoop.h"
#include <AK/HashMap.h>
#include <AK/HashTable.h>
#include <AK/QuickSort.h>
#include <AK/OwnPtr.h>
#include <AK/kmalloc.h>
#include <AK/StringBuilder.h>
#include <AK/Time.h>
#include <LibCore/Timer.h>
#include <LibURL/Parser.h>
#include <brotli/decode.h>
#include <nghttp2/nghttp2.h>
#include <openssl/err.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>
#include <zlib.h>

extern "C" {
void ganglion_host_log(char const* text, size_t length);
void ganglion_host_tcp_connect(uint32_t stream_id, char const* host, size_t host_length, uint32_t port);
// A synchronous stream: opened inside a nested wait (a synchronous XMLHttpRequest), its events reach the engine while the
// host's thread is blocked (EventLoop.cpp ganglion_host_wait), not through the host's event loop.
void ganglion_host_tcp_connect_sync(uint32_t stream_id, char const* host, size_t host_length, uint32_t port);
void ganglion_host_tcp_write(uint32_t stream_id, uint8_t const* bytes, size_t length);
void ganglion_host_tcp_close(uint32_t stream_id);
}

namespace Ganglion::Net {

static void log(ByteString const& text)
{
    ganglion_host_log(text.characters(), text.length());
}

static double now_ms()
{
    return static_cast<double>(MonotonicTime::now().nanoseconds()) / 1e6;
}

static constexpr size_t MAX_CONNECTIONS_PER_ORIGIN = 6;
// All of a segment's connections together (and its WebSocket tunnels). Spiracle refuses a segment's streams past its own cap
// (harness/carapace/guard.mjs, 128) and the relay counts 64 per WebSocket; Chrome's socket pool holds 256 and, when full, closes
// an idle socket of another group for a new one (ClientSocketPool "CloseOneIdleSocket"). Past this cap the least recently used
// idle connection is closed, or the request waits for a connection to close.
static constexpr size_t MAX_CONNECTIONS_TOTAL = 60;
static bool s_waiting_for_room { false };
static constexpr size_t MAX_HEADER_BLOCK = 256 * 1024;
static constexpr double CONNECT_TIMEOUT_MS = 30000;
static constexpr double RESPONSE_TIMEOUT_MS = 60000; // no byte of a response for this long
static constexpr double IDLE_TIMEOUT_MS = 55000;     // most servers close idle keep-alive at 60 s

static Stats s_stats;
Stats const& stats() { return s_stats; }

// --- Content decoding ------------------------------------------------------------------------------

class Decoder {
    AK_MAKE_NONCOPYABLE(Decoder);
    AK_MAKE_NONMOVABLE(Decoder);
    AK_ALLOC_WITH_KMALLOC;

public:
    enum class Kind { Identity, Zlib, Brotli };

    static OwnPtr<Decoder> for_encoding(StringView encoding)
    {
        auto e = encoding.trim_whitespace();
        if (e.equals_ignoring_ascii_case("gzip"sv) || e.equals_ignoring_ascii_case("x-gzip"sv))
            return adopt_own(*new Decoder(Kind::Zlib, 16 + MAX_WBITS));
        if (e.equals_ignoring_ascii_case("deflate"sv))
            return adopt_own(*new Decoder(Kind::Zlib, MAX_WBITS));
        if (e.equals_ignoring_ascii_case("br"sv))
            return adopt_own(*new Decoder(Kind::Brotli, 0));
        return nullptr; // identity, or something unknown that is passed through
    }

    Decoder(Kind kind, int window_bits)
        : m_kind(kind)
        , m_window_bits(window_bits)
    {
        if (kind == Kind::Zlib) {
            m_z = {};
            m_zlib_ok = inflateInit2(&m_z, window_bits) == Z_OK;
        } else if (kind == Kind::Brotli) {
            m_brotli = BrotliDecoderCreateInstance(nullptr, nullptr, nullptr);
        }
    }

    ~Decoder()
    {
        if (m_kind == Kind::Zlib && m_zlib_ok)
            inflateEnd(&m_z);
        if (m_brotli)
            BrotliDecoderDestroyInstance(m_brotli);
    }

    // Decodes `in`, calling `out` with each run of plaintext. An error names itself.
    ErrorOr<void> push(ReadonlyBytes in, Function<void(ReadonlyBytes)> const& out)
    {
        u8 buffer[32768];
        if (m_kind == Kind::Zlib) {
            if (!m_zlib_ok)
                return Error::from_string_literal("zlib could not be initialised");
            m_z.next_in = const_cast<Bytef*>(in.data());
            m_z.avail_in = in.size();
            while (m_z.avail_in > 0 || m_first) {
                m_z.next_out = buffer;
                m_z.avail_out = sizeof(buffer);
                int rc = inflate(&m_z, Z_NO_FLUSH);
                if (rc == Z_DATA_ERROR && m_first && m_window_bits == MAX_WBITS) {
                    // "deflate" that is really raw deflate (no zlib wrapper): start again without it.
                    inflateEnd(&m_z);
                    m_z = {};
                    m_zlib_ok = inflateInit2(&m_z, -MAX_WBITS) == Z_OK;
                    m_window_bits = -MAX_WBITS;
                    m_z.next_in = const_cast<Bytef*>(in.data());
                    m_z.avail_in = in.size();
                    continue;
                }
                m_first = false;
                if (rc != Z_OK && rc != Z_STREAM_END && rc != Z_BUF_ERROR)
                    return Error::from_string_literal("the compressed body is corrupt (zlib)");
                size_t produced = sizeof(buffer) - m_z.avail_out;
                if (produced)
                    out({ buffer, produced });
                if (rc == Z_STREAM_END) {
                    m_finished = true;
                    break;
                }
                if (rc == Z_BUF_ERROR && produced == 0)
                    break; // needs more input
            }
            return {};
        }
        if (m_kind == Kind::Brotli) {
            if (!m_brotli)
                return Error::from_string_literal("brotli could not be initialised");
            u8 const* next_in = in.data();
            size_t avail_in = in.size();
            while (true) {
                u8* next_out = buffer;
                size_t avail_out = sizeof(buffer);
                auto rc = BrotliDecoderDecompressStream(m_brotli, &avail_in, &next_in, &avail_out, &next_out, nullptr);
                size_t produced = sizeof(buffer) - avail_out;
                if (produced)
                    out({ buffer, produced });
                if (rc == BROTLI_DECODER_RESULT_ERROR)
                    return Error::from_string_literal("the compressed body is corrupt (brotli)");
                if (rc == BROTLI_DECODER_RESULT_SUCCESS) {
                    m_finished = true;
                    break;
                }
                if (rc == BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT)
                    break;
                // NEEDS_MORE_OUTPUT: loop
            }
            return {};
        }
        out(in);
        return {};
    }

private:
    Kind m_kind;
    int m_window_bits;
    z_stream m_z {};
    bool m_zlib_ok { false };
    bool m_first { true };
    bool m_finished { false };
    BrotliDecoderState* m_brotli { nullptr };
};

// --- TLS ---------------------------------------------------------------------------------------------

static SSL_CTX* s_ssl_ctx;
static HashMap<ByteString, SSL_SESSION*> s_sessions; // host:port -> the last session, for resumption

struct TlsSession;
static int new_session_callback(SSL* ssl, SSL_SESSION* session);

static SSL_CTX& ssl_context()
{
    if (s_ssl_ctx)
        return *s_ssl_ctx;
    s_ssl_ctx = SSL_CTX_new(TLS_client_method());
    VERIFY(s_ssl_ctx);
    SSL_CTX_set_min_proto_version(s_ssl_ctx, TLS1_2_VERSION);
    SSL_CTX_set_verify(s_ssl_ctx, SSL_VERIFY_PEER, nullptr);
    SSL_CTX_set_mode(s_ssl_ctx, SSL_MODE_ENABLE_PARTIAL_WRITE | SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER);
    // ALPN is offered per connection (TlsSession::start): "h2" then "http/1.1", or "http/1.1" alone.
    SSL_CTX_set_session_cache_mode(s_ssl_ctx, SSL_SESS_CACHE_CLIENT | SSL_SESS_CACHE_NO_INTERNAL_STORE);
    SSL_CTX_sess_set_new_cb(s_ssl_ctx, new_session_callback);
    return *s_ssl_ctx;
}

void set_ca_bundle(ReadonlyBytes pem)
{
    auto& ctx = ssl_context();
    auto* store = X509_STORE_new();
    auto* bio = BIO_new_mem_buf(pem.data(), static_cast<int>(pem.size()));
    u32 count = 0;
    while (auto* cert = PEM_read_bio_X509(bio, nullptr, nullptr, nullptr)) {
        if (X509_STORE_add_cert(store, cert) == 1)
            count++;
        X509_free(cert);
    }
    ERR_clear_error(); // the loop ends on "no start line", which is not an error
    BIO_free(bio);
    SSL_CTX_set_cert_store(&ctx, store); // the context takes ownership
    s_stats.ca_certificates = count;
    log(ByteString::formatted("ganglion: trust store: {} CA certificates", count));
}

struct TlsSession {
    AK_MAKE_NONCOPYABLE(TlsSession);
    AK_MAKE_NONMOVABLE(TlsSession);
    AK_ALLOC_WITH_KMALLOC;
    TlsSession() = default;

    SSL* ssl { nullptr };
    BIO* rbio { nullptr }; // bytes from the network, for OpenSSL to read
    BIO* wbio { nullptr }; // bytes OpenSSL wants on the network
    bool handshake_done { false };
    bool peer_closed { false };
    double handshake_started_ms { 0 };
    double handshake_cpu_ms { 0 };
    ByteString session_key;

    ~TlsSession()
    {
        if (ssl)
            SSL_free(ssl); // frees both BIOs
    }

    // `offer_h2`: ALPN offers "h2" before "http/1.1" (RFC 9113 section 3.2, RFC 7301); off for an upgrade tunnel (a WebSocket
    // handshake is HTTP/1.1; RFC 8441 is not used) and for an origin that answered HTTP_1_1_REQUIRED.
    ErrorOr<void> start(ByteString const& host, u16 port, bool offer_h2)
    {
        ssl = SSL_new(&ssl_context());
        if (!ssl)
            return Error::from_string_literal("SSL_new failed");
        rbio = BIO_new(BIO_s_mem());
        wbio = BIO_new(BIO_s_mem());
        SSL_set_bio(ssl, rbio, wbio);
        SSL_set_connect_state(ssl);
        SSL_set_app_data(ssl, this);
        static unsigned char const alpn_h2[] = "\x02h2\x08http/1.1";
        static unsigned char const alpn_h1[] = "\x08http/1.1";
        if (offer_h2)
            SSL_set_alpn_protos(ssl, alpn_h2, sizeof(alpn_h2) - 1);
        else
            SSL_set_alpn_protos(ssl, alpn_h1, sizeof(alpn_h1) - 1);
        // An IP literal gets no SNI (RFC 6066: literals are not permitted in server_name).
        bool literal = host.starts_with('[');
        if (!literal) {
            auto dot = host.find_last('.');
            literal = dot.has_value() && host.substring_view(*dot + 1).to_number<u32>().has_value();
        }
        if (!literal)
            SSL_set_tlsext_host_name(ssl, host.characters());
        // The hostname check (RFC 6125 through X509_VERIFY_PARAM; SSL_set1_host handles IP literals too).
        SSL_set_hostflags(ssl, X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS);
        if (SSL_set1_host(ssl, host.characters()) != 1)
            return Error::from_string_literal("SSL_set1_host failed");
        session_key = ByteString::formatted("{}:{}", host, port);
        if (auto saved = s_sessions.get(session_key); saved.has_value())
            SSL_set_session(ssl, *saved);
        handshake_started_ms = now_ms();
        return {};
    }

    // The protocol the server selected ("h2", "http/1.1"), empty when it selected none.
    StringView alpn() const
    {
        unsigned char const* data = nullptr;
        unsigned int length = 0;
        SSL_get0_alpn_selected(ssl, &data, &length);
        if (!data || !length)
            return {}; // the server selected nothing (no ALPN on its side): HTTP/1.1
        return { reinterpret_cast<char const*>(data), length };
    }

    // Whether the server's certificate, already verified for the name this connection was opened to, is also valid for
    // `host` (RFC 6125 through X509_check_host / X509_check_ip_asc): the certificate half of connection pooling.
    bool certificate_covers(ByteString const& host) const
    {
        auto* cert = SSL_get0_peer_certificate(ssl);
        if (!cert || SSL_get_verify_result(ssl) != X509_V_OK)
            return false;
        bool ip = host.contains(':') || (host.find_last('.').has_value() && host.substring_view(*host.find_last('.') + 1).to_number<u32>().has_value());
        int ok = ip ? X509_check_ip_asc(cert, host.characters(), 0) : X509_check_host(cert, host.characters(), host.length(), X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS, nullptr);
        ERR_clear_error();
        return ok == 1;
    }

    void feed(ReadonlyBytes bytes)
    {
        size_t written = 0;
        while (written < bytes.size()) {
            int n = BIO_write(rbio, bytes.data() + written, static_cast<int>(bytes.size() - written));
            if (n <= 0)
                break;
            written += n;
        }
    }

    // Everything OpenSSL queued for the network.
    void drain(Vector<u8>& out)
    {
        u8 buffer[16384];
        while (BIO_ctrl_pending(wbio) > 0) {
            int n = BIO_read(wbio, buffer, sizeof(buffer));
            if (n <= 0)
                break;
            out.append(buffer, n);
        }
    }

    // Returns true once the handshake is complete; an error names itself.
    ErrorOr<bool> handshake()
    {
        if (handshake_done)
            return true;
        auto t0 = now_ms();
        int r = SSL_do_handshake(ssl);
        handshake_cpu_ms += now_ms() - t0;
        if (r == 1) {
            handshake_done = true;
            return true;
        }
        int err = SSL_get_error(ssl, r);
        if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE)
            return false;
        return error("TLS handshake failed"sv);
    }

    ErrorOr<void> write(ReadonlyBytes bytes, size_t& written)
    {
        written = 0;
        while (written < bytes.size()) {
            size_t n = 0;
            if (SSL_write_ex(ssl, bytes.data() + written, bytes.size() - written, &n) != 1) {
                int err = SSL_get_error(ssl, 0);
                if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE)
                    return {};
                return error("TLS write failed"sv);
            }
            written += n;
        }
        return {};
    }

    // Plaintext OpenSSL has ready; sets peer_closed on a close_notify.
    ErrorOr<void> read(Vector<u8>& out)
    {
        u8 buffer[16384];
        while (true) {
            size_t n = 0;
            if (SSL_read_ex(ssl, buffer, sizeof(buffer), &n) == 1) {
                out.append(buffer, n);
                continue;
            }
            int err = SSL_get_error(ssl, 0);
            if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE)
                return {};
            if (err == SSL_ERROR_ZERO_RETURN) {
                peer_closed = true;
                return {};
            }
            if (err == SSL_ERROR_SYSCALL && ERR_peek_error() == 0) {
                // EOF without close_notify: common; treat as closed.
                peer_closed = true;
                return {};
            }
            return error("TLS read failed"sv);
        }
    }

    // The text is kept in a static so the Error can refer to it (an Error holds a view); callers format
    // it into their own ByteString at once.
    Error error(StringView what)
    {
        static ByteString s_last_error;
        long verify = SSL_get_verify_result(ssl);
        if (verify != X509_V_OK) {
            ERR_clear_error();
            s_last_error = ByteString::formatted("certificate verification failed: {}", X509_verify_cert_error_string(verify));
            return Error::from_string_view(s_last_error.view());
        }
        char buffer[256] = {};
        unsigned long code = ERR_get_error();
        if (code)
            ERR_error_string_n(code, buffer, sizeof(buffer));
        ERR_clear_error();
        s_last_error = code ? ByteString::formatted("{}: {}", what, buffer) : ByteString(what);
        return Error::from_string_view(s_last_error.view());
    }
};

static int new_session_callback(SSL* ssl, SSL_SESSION* session)
{
    auto* tls = static_cast<TlsSession*>(SSL_get_app_data(ssl));
    if (!tls)
        return 0;
    if (auto old = s_sessions.get(tls->session_key); old.has_value())
        SSL_SESSION_free(*old);
    s_sessions.set(tls->session_key, session);
    return 1; // we keep the reference
}

// --- Requests and connections --------------------------------------------------------------------------

struct TunnelState : public RefCounted<TunnelState> {
    u32 id { 0 };
    TunnelSink sink;
    bool closed { false };
};

struct Request : public RefCounted<Request> {
    RequestSpec spec;
    Sink sink;
    RefPtr<TunnelState> tunnel; // an upgrade request: a 101 turns its connection into the tunnel
    ByteString key;             // its origin's pool (scheme://host:port)
    u64 order { 0 };            // submission order, for FIFO within an urgency
    bool retried { false };
    u8 refusals { 0 };          // times an HTTP/2 server refused it unprocessed (REFUSED_STREAM, beyond a GOAWAY)
    bool head { false };
    // Response state
    bool headers_done { false };
    u32 status { 0 };
    ByteString reason;
    RefPtr<HTTP::HeaderList> headers;
    RefPtr<HTTP::HeaderList> trailers; // HTTP/2 trailers (kept, not exposed: Fetch has no trailer API)
    enum class Framing { None, ContentLength, Chunked, UntilClose };
    Framing framing { Framing::UntilClose };
    u64 remaining { 0 };           // content-length left, or the current chunk's remaining bytes
    enum class ChunkState { Size, Data, DataCRLF, Trailers };
    ChunkState chunk_state { ChunkState::Size };
    OwnPtr<Decoder> decoder;
    bool done { false };
    bool saw_response_byte { false };
    bool sync { false };              // made inside a nested wait: rides a synchronous connection of its own
    double started_ms { 0 };
    Timing timing;
    // HTTP/2
    i32 stream_id { 0 };
    size_t body_sent { 0 };
};

struct H2Event {
    enum class Kind { Headers, Data, Closed };
    Kind kind;
    NonnullRefPtr<Request> request;
    Vector<u8> data;
    u32 error { 0 };
};

struct Connection {
    AK_MAKE_NONCOPYABLE(Connection);
    AK_MAKE_NONMOVABLE(Connection);

public:
    Connection() = default;
    ~Connection()
    {
        if (h2)
            nghttp2_session_del(h2);
    }

    u32 id;
    ByteString key;   // scheme://host:port
    ByteString host;
    u16 port;
    bool tls;
    bool offer_h2 { false };
    OwnPtr<TlsSession> session;
    enum class State { Connecting, Handshaking, Ready, Closed };
    State state { State::Connecting };
    enum class Protocol { Unknown, Http1, Http2 };
    Protocol protocol { Protocol::Unknown };
    RefPtr<Request> current;          // HTTP/1.1: the request on the wire; before Ready: the request that opened it
    RefPtr<TunnelState> tunnel;       // set once the upgrade was answered with 101
    bool reused { false };            // the current request started on an already-open connection
    Vector<u8> pending_plain;         // request bytes waiting for the connection (or handshake)
    Vector<u8> rx;                    // response bytes not parsed yet (plaintext)
    bool keep_alive { true };
    bool sync { false };              // a synchronous stream (ganglion_host_tcp_connect_sync): one request, then closed
    double opened_ms { 0 };
    double tls_start_ms { 0 };
    double ready_ms { 0 };
    double last_activity_ms { 0 };
    u64 bytes_in { 0 };
    u64 bytes_out { 0 };
    ByteString peer_address;          // the address the host connected to, when it said (pooling)
    // HTTP/2
    nghttp2_session* h2 { nullptr };
    HashMap<i32, NonnullRefPtr<Request>> streams;
    Vector<H2Event> h2_events;        // what nghttp2's callbacks saw, delivered once it has returned
    bool draining { false };          // GOAWAY received (or sent): no new streams
    i32 goaway_last_stream_id { 0x7fffffff };
    u32 goaway_error { 0 };
    u64 streams_opened { 0 };
};

struct Pool {
    Vector<Connection*> connections;
    Vector<NonnullRefPtr<Request>> waiting;
};

static HashMap<ByteString, Pool> s_pools;
static HashMap<u32, Connection*> s_by_stream;
static HashMap<u32, NonnullRefPtr<TunnelState>> s_tunnels;
static u32 s_next_stream_id { 1 };
static u64 s_generation { 0 };
static u64 s_next_order { 0 };
static RefPtr<Core::Timer> s_timer;
// What each https origin's server selected by ALPN last time (true: h2), kept across navigations as Chrome's
// HttpServerProperties keeps it; and the origins that answered HTTP_1_1_REQUIRED (RFC 9113 section 8.7), offered
// "http/1.1" alone from then on.
static HashMap<ByteString, bool> s_speaks_h2;
static HashTable<ByteString> s_h1_only;
// Name resolution answers the host reported (ganglion_net_dns): the pooling rule needs them.
static HashMap<ByteString, Vector<ByteString>> s_dns;

static void dispatch(ByteString const& key);
static void dispatch_all();
static void close_connection(Connection&, ByteString const& reason, bool tell_host = true);
static void fail_request(Connection&, ByteString const& message);
static bool send_plain(Connection&, ReadonlyBytes);
static void on_plaintext(Connection&);
static bool deliver_body(Request&, ReadonlyBytes, ByteString& error);
static void complete_ok(Request&);
static bool h2_send(Connection&);
static void h2_close_idle(Connection&);

static bool alive(u32 id, Connection const* c)
{
    auto it = s_by_stream.find(id);
    return it != s_by_stream.end() && it->value == c;
}

// Closes the least recently used idle connection (HTTP/1.1 without a request, HTTP/2 without a stream); false when none is idle.
static bool close_one_idle_connection()
{
    Connection* lru = nullptr;
    for (auto& [id, c] : s_by_stream) {
        if (c->state != Connection::State::Ready || c->tunnel || c->sync || c->current)
            continue;
        if (c->protocol == Connection::Protocol::Http2 ? !c->streams.is_empty() : c->protocol != Connection::Protocol::Http1)
            continue;
        if (!lru || c->last_activity_ms < lru->last_activity_ms)
            lru = c;
    }
    if (!lru)
        return false;
    close_connection(*lru, "idle (connection limit)");
    return true;
}

static void ensure_timer()
{
    if (s_timer)
        return;
    s_timer = Core::Timer::create_repeating(1000, [] {
        auto now = now_ms();
        Vector<Connection*> to_close;
        Vector<Connection*> to_fail;
        Vector<Connection*> to_retire;
        for (auto& [id, c] : s_by_stream) {
            if (c->state == Connection::State::Connecting || c->state == Connection::State::Handshaking) {
                if (now - c->opened_ms > CONNECT_TIMEOUT_MS)
                    to_fail.append(c);
            } else if (c->tunnel) {
                continue; // an upgraded connection lives as long as its user keeps it
            } else if (c->protocol == Connection::Protocol::Http2) {
                if (!c->streams.is_empty()) {
                    if (now - c->last_activity_ms > RESPONSE_TIMEOUT_MS)
                        to_fail.append(c);
                } else if (now - c->last_activity_ms > IDLE_TIMEOUT_MS) {
                    to_retire.append(c);
                }
            } else if (c->current) {
                if (now - c->last_activity_ms > RESPONSE_TIMEOUT_MS)
                    to_fail.append(c);
            } else if (now - c->last_activity_ms > IDLE_TIMEOUT_MS) {
                to_close.append(c);
            }
        }
        for (auto* c : to_fail) {
            auto id = c->id;
            if (!alive(id, c))
                continue;
            fail_request(*c, c->state == Connection::State::Connecting ? "connection timed out" : c->state == Connection::State::Handshaking ? "TLS handshake timed out" : "the server stopped responding");
        }
        for (auto* c : to_close) {
            if (alive(c->id, c))
                close_connection(*c, "idle");
        }
        for (auto* c : to_retire) {
            if (alive(c->id, c))
                h2_close_idle(*c);
        }
        // Requests held at the connection cap: a connection that went idle since can now be closed for them.
        if (s_waiting_for_room) {
            s_waiting_for_room = false;
            dispatch_all();
        }
        if (s_by_stream.is_empty() && s_timer) {
            s_timer->stop();
            s_timer = nullptr;
        }
    });
    s_timer->start();
}

static ByteString origin_key(URL::URL const& url)
{
    return ByteString::formatted("{}://{}:{}", url.scheme(), url.serialized_host(), url.port_or_default());
}

static ByteString bare_host(URL::URL const& url)
{
    ByteString host = url.serialized_host();
    if (host.starts_with('[') && host.ends_with(']'))
        host = host.substring(1, host.length() - 2);
    return host;
}

// The client hints (docs/surface.md): the three low-entropy Sec-CH-UA headers, set once by the host from the same identity
// navigator.userAgentData answers with. Sent on https requests only, as Chrome sends them to secure contexts.
// A URL the site-compatibility list hides the Chitin product from (its User-Agent is not the default) gets the brand list
// without Chitin, as navigator.userAgentData shows it there.
static ByteString s_sec_ch_ua, s_sec_ch_ua_mobile, s_sec_ch_ua_platform, s_sec_ch_ua_hidden;

void set_client_hints(ByteString sec_ch_ua, ByteString mobile, ByteString platform, ByteString sec_ch_ua_hidden)
{
    s_sec_ch_ua_hidden = move(sec_ch_ua_hidden);
    s_sec_ch_ua = move(sec_ch_ua);
    s_sec_ch_ua_mobile = move(mobile);
    s_sec_ch_ua_platform = move(platform);
}

static bool is_potentially_trustworthy(URL::URL const& url);

// The request's header fields after the request line and Host, the same for both versions: the caller's, the client hints,
// and Accept-Encoding / Content-Length when absent. `h1`: also Connection: keep-alive (HTTP/2 has no connection-specific
// fields, RFC 9113 section 8.2.2, so the HTTP/2 path drops those of the caller too).
static Vector<Header> outgoing_headers(Request const& request, bool h1)
{
    auto const& url = request.spec.url;
    Vector<Header> out;
    bool has_encoding = false, has_connection = false, has_length = false;
    for (auto const& h : request.spec.headers) {
        if (h.name.equals_ignoring_ascii_case("host"sv))
            continue;
        if (h.name.equals_ignoring_ascii_case("accept-encoding"sv))
            has_encoding = true;
        else if (h.name.equals_ignoring_ascii_case("connection"sv))
            has_connection = true;
        else if (h.name.equals_ignoring_ascii_case("content-length"sv))
            has_length = true;
        // LibWeb's Fetch derives the three low-entropy hints from the user agent string (Chromium only); with an identity set,
        // the host's replace them so the brand list is the one navigator.userAgentData answers with.
        if (!s_sec_ch_ua.is_empty() && h.name.is_one_of_ignoring_ascii_case("sec-ch-ua"sv, "sec-ch-ua-mobile"sv, "sec-ch-ua-platform"sv))
            continue;
        if (!h1) {
            if (h.name.is_one_of_ignoring_ascii_case("connection"sv, "keep-alive"sv, "proxy-connection"sv, "transfer-encoding"sv, "upgrade"sv))
                continue;
            // TE is allowed only as "trailers" (RFC 9113 section 8.2.2).
            if (h.name.equals_ignoring_ascii_case("te"sv) && !h.value.equals_ignoring_ascii_case("trailers"sv))
                continue;
        }
        out.append(h);
    }
    if (is_potentially_trustworthy(url) && !s_sec_ch_ua.is_empty()) {
        bool hidden = Web::ResourceLoader::is_initialized() && Web::ResourceLoader::the().user_agent_for_url(url) != Web::ResourceLoader::the().user_agent();
        out.append({ "Sec-CH-UA", hidden ? s_sec_ch_ua_hidden : s_sec_ch_ua });
        out.append({ "Sec-CH-UA-Mobile", s_sec_ch_ua_mobile });
        out.append({ "Sec-CH-UA-Platform", s_sec_ch_ua_platform });
    }
    if (!has_encoding)
        out.append({ "Accept-Encoding", "gzip, deflate, br" });
    if (h1 && !has_connection)
        out.append({ "Connection", "keep-alive" });
    bool needs_length = !request.spec.body.is_empty() || request.spec.method.is_one_of("POST"sv, "PUT"sv, "PATCH"sv);
    if (!has_length && needs_length)
        out.append({ "Content-Length", ByteString::number(request.spec.body.size()) });
    return out;
}

static ByteString authority(URL::URL const& url)
{
    StringBuilder b;
    b.append(url.serialized_host());
    auto default_port = URL::default_port_for_scheme(url.scheme());
    if (url.port().has_value() && (!default_port.has_value() || *url.port() != *default_port))
        b.appendff(":{}", *url.port());
    return b.to_byte_string();
}

static ByteString request_target(URL::URL const& url)
{
    StringBuilder b;
    auto path = url.serialize_path();
    b.append(path.is_empty() ? "/"sv : path);
    if (auto query = url.query(); query.has_value()) {
        b.append('?');
        b.append(*query);
    }
    return b.to_byte_string();
}

static ByteString serialize_request(Request const& request)
{
    auto const& url = request.spec.url;
    StringBuilder b;
    b.append(request.spec.method);
    b.append(' ');
    b.append(request_target(url));
    b.append(" HTTP/1.1\r\nHost: "sv);
    b.append(authority(url));
    b.append("\r\n"sv);
    for (auto const& h : outgoing_headers(request, true)) {
        b.append(h.name);
        b.append(": "sv);
        b.append(h.value);
        b.append("\r\n"sv);
    }
    b.append("\r\n"sv);
    b.append(request.spec.body);
    return b.to_byte_string();
}

static void start_request(Connection& c, NonnullRefPtr<Request> request, bool reused)
{
    c.current = request;
    c.reused = reused;
    c.rx.clear_with_capacity();
    c.last_activity_ms = now_ms();
    request->started_ms = c.last_activity_ms;
    // On a new connection the request is written once it is ready (flush_pending): its request start is set there.
    if (reused)
        request->timing.request_start_ms = request->started_ms;
    request->head = request->spec.method.equals_ignoring_ascii_case("HEAD"sv);
    auto bytes = serialize_request(*request);
    send_plain(c, bytes.bytes());
}

// --- HTTP/2 (RFC 9113) through nghttp2 ------------------------------------------------------------------------------------
//
// nghttp2 does the framing, HPACK, stream states and flow control; this code owns the bytes (nghttp2_session_mem_recv2 with
// TLS plaintext in, nghttp2_session_mem_send2 out through the same TLS session) and the requests. Its callbacks only record
// what happened (Connection::h2_events): the sinks run page code that can navigate (reset) or close connections, which must
// not happen while nghttp2 is on the stack, so events are delivered after it returns, each one checking that the
// connection and the generation are still there.
//
// SETTINGS are Chrome's (header table 65536, push off, initial window 6 MiB, header list 256 KiB; frame size 16384 and
// no limit on concurrent streams, the defaults), a 15 MiB connection window, and SETTINGS_NO_RFC7540_PRIORITIES = 1 (RFC 9218 section 2.1: priorities are signalled with the Priority header instead
// of the deprecated RFC 7540 tree). nghttp2 sends WINDOW_UPDATE for data as it is received (its automatic mode).

static bool is_idempotent(Request const& r)
{
    return r.spec.method.is_one_of("GET"sv, "HEAD"sv, "OPTIONS"sv, "PUT"sv, "DELETE"sv, "TRACE"sv);
}

static Request* stream_request(nghttp2_session* session, i32 stream_id)
{
    return static_cast<Request*>(nghttp2_session_get_stream_user_data(session, stream_id));
}

static int h2_on_begin_headers(nghttp2_session* session, nghttp2_frame const* frame, void*)
{
    if (frame->hd.type != NGHTTP2_HEADERS)
        return 0;
    auto* r = stream_request(session, frame->hd.stream_id);
    if (!r)
        return 0;
    if (r->headers_done) {
        r->trailers = HTTP::HeaderList::create();
    } else {
        r->headers = HTTP::HeaderList::create();
        r->status = 0;
    }
    return 0;
}

static int h2_on_header(nghttp2_session* session, nghttp2_frame const* frame, u8 const* name, size_t name_length, u8 const* value, size_t value_length, u8, void*)
{
    if (frame->hd.type != NGHTTP2_HEADERS)
        return 0;
    auto* r = stream_request(session, frame->hd.stream_id);
    if (!r)
        return 0;
    StringView n { name, name_length };
    StringView v { value, value_length };
    if (r->headers_done) {
        if (r->trailers && !n.starts_with(':'))
            r->trailers->append(HTTP::Header::isomorphic_encode(n, v));
        return 0;
    }
    if (n == ":status"sv) {
        r->status = v.to_number<u32>().value_or(0);
        return 0;
    }
    if (n.starts_with(':') || !r->headers)
        return 0;
    r->headers->append(HTTP::Header::isomorphic_encode(n, v));
    return 0;
}

static int h2_on_frame_recv(nghttp2_session* session, nghttp2_frame const* frame, void* user_data)
{
    auto& c = *static_cast<Connection*>(user_data);
    switch (frame->hd.type) {
    case NGHTTP2_HEADERS: {
        auto* r = stream_request(session, frame->hd.stream_id);
        if (!r || r->headers_done || !r->headers)
            break; // trailers, or nothing of ours
        if (r->timing.response_start_ms == 0)
            r->timing.response_start_ms = now_ms();
        r->saw_response_byte = true;
        if (r->status >= 100 && r->status < 200) {
            r->headers = nullptr; // 103 Early Hints and the like: informational, the response follows
            break;
        }
        r->headers_done = true;
        r->framing = (r->head || r->status == 204 || r->status == 304) ? Request::Framing::None : Request::Framing::UntilClose;
        if (auto ce = r->headers->get("Content-Encoding"sv); ce.has_value() && r->framing != Request::Framing::None)
            r->decoder = Decoder::for_encoding(*ce);
        c.h2_events.append({ H2Event::Kind::Headers, *r, {}, 0 });
        break;
    }
    case NGHTTP2_GOAWAY:
        c.draining = true;
        c.goaway_last_stream_id = frame->goaway.last_stream_id;
        c.goaway_error = frame->goaway.error_code;
        break;
    default:
        break;
    }
    return 0;
}

static int h2_on_data_chunk(nghttp2_session* session, u8, i32 stream_id, u8 const* data, size_t length, void* user_data)
{
    auto& c = *static_cast<Connection*>(user_data);
    auto* r = stream_request(session, stream_id);
    if (!r || length == 0)
        return 0;
    r->saw_response_byte = true;
    if (!c.h2_events.is_empty() && c.h2_events.last().kind == H2Event::Kind::Data && c.h2_events.last().request.ptr() == r) {
        c.h2_events.last().data.append(data, length);
        return 0;
    }
    H2Event event { H2Event::Kind::Data, *r, {}, 0 };
    event.data.append(data, length);
    c.h2_events.append(move(event));
    return 0;
}

static int h2_on_stream_close(nghttp2_session* session, i32 stream_id, u32 error_code, void* user_data)
{
    auto& c = *static_cast<Connection*>(user_data);
    auto* r = stream_request(session, stream_id);
    if (!r)
        return 0;
    c.h2_events.append({ H2Event::Kind::Closed, *r, {}, error_code });
    return 0;
}

static nghttp2_ssize h2_read_body(nghttp2_session*, i32, u8* buffer, size_t length, u32* flags, nghttp2_data_source* source, void*)
{
    auto& r = *static_cast<Request*>(source->ptr);
    auto& body = r.spec.body;
    size_t n = min(length, body.size() - r.body_sent);
    if (n)
        memcpy(buffer, body.data() + r.body_sent, n);
    r.body_sent += n;
    if (r.body_sent == body.size())
        *flags |= NGHTTP2_DATA_FLAG_EOF;
    return static_cast<nghttp2_ssize>(n);
}

static nghttp2_session_callbacks* h2_callbacks()
{
    static nghttp2_session_callbacks* s_callbacks;
    if (s_callbacks)
        return s_callbacks;
    nghttp2_session_callbacks_new(&s_callbacks);
    nghttp2_session_callbacks_set_on_begin_headers_callback(s_callbacks, h2_on_begin_headers);
    nghttp2_session_callbacks_set_on_header_callback(s_callbacks, h2_on_header);
    nghttp2_session_callbacks_set_on_frame_recv_callback(s_callbacks, h2_on_frame_recv);
    nghttp2_session_callbacks_set_on_data_chunk_recv_callback(s_callbacks, h2_on_data_chunk);
    nghttp2_session_callbacks_set_on_stream_close_callback(s_callbacks, h2_on_stream_close);
    return s_callbacks;
}

// Starts the HTTP/2 session on a connection whose server selected "h2": the connection preface and our SETTINGS.
static bool h2_begin(Connection& c)
{
    if (nghttp2_session_client_new2(&c.h2, h2_callbacks(), &c, nullptr) != 0)
        return false;
    // Chrome's SETTINGS and windows: 6 MiB per stream, 15 MiB for the connection (its WINDOW_UPDATE of 15,663,105 right
    // after SETTINGS). With RFC 9113's 64 KiB a large response arrives at 64 KiB per round trip: 0.6 MB/s at 100 ms.
    nghttp2_settings_entry settings[] = {
        { NGHTTP2_SETTINGS_HEADER_TABLE_SIZE, 65536 },
        { NGHTTP2_SETTINGS_ENABLE_PUSH, 0 },
        { NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE, 6 * 1024 * 1024 },
        { NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE, 262144 },
        { NGHTTP2_SETTINGS_NO_RFC7540_PRIORITIES, 1 },
    };
    if (nghttp2_submit_settings(c.h2, NGHTTP2_FLAG_NONE, settings, array_size(settings)) != 0)
        return false;
    if (nghttp2_session_set_local_window_size(c.h2, NGHTTP2_FLAG_NONE, 0, 15 * 1024 * 1024) != 0)
        return false;
    c.protocol = Connection::Protocol::Http2;
    s_stats.h2_connections++;
    return true;
}

// The urgency of a request (RFC 9218 section 4.1 leaves the scheme to the client). Ours, by what the response blocks:
//   0  documents (navigations, frames) and stylesheets: nothing renders without them
//   1  scripts, fonts, JSON modules, workers: they block parsing, text or a script's run
//   2  fetch() and XMLHttpRequest (no destination): a script waits for them
//   3  the rest (the default urgency)
//   4  images, audio, video, sent incremental: a part of one is already useful
// A priority hint moves it one step: "high" up (to at most 0), "low" down (to at most 7).
Priority priority_for(StringView destination, StringView fetch_priority, bool navigation)
{
    Priority p;
    if (navigation || destination.is_one_of("document"sv, "iframe"sv, "frame"sv, "style"sv))
        p.urgency = 0;
    else if (destination.is_one_of("script"sv, "font"sv, "json"sv, "worker"sv, "sharedworker"sv, "serviceworker"sv, "audioworklet"sv, "paintworklet"sv))
        p.urgency = 1;
    else if (destination.is_empty())
        p.urgency = 2;
    else if (destination.is_one_of("image"sv, "audio"sv, "video"sv)) {
        p.urgency = 4;
        p.incremental = true;
    }
    if (fetch_priority.equals_ignoring_ascii_case("high"sv) && p.urgency > 0)
        p.urgency--;
    else if (fetch_priority.equals_ignoring_ascii_case("low"sv) && p.urgency < 7)
        p.urgency++;
    return p;
}

// The Priority field (RFC 9218 section 4): omitted at the defaults (u=3, not incremental).
static ByteString priority_field(RequestSpec const& spec)
{
    if (spec.urgency == 3 && !spec.incremental)
        return {};
    if (spec.urgency == 3)
        return "i";
    return spec.incremental ? ByteString::formatted("u={}, i", spec.urgency) : ByteString::formatted("u={}", spec.urgency);
}

// How many more streams the server lets us open now.
static size_t h2_free_streams(Connection const& c)
{
    u32 limit = nghttp2_session_get_remote_settings(c.h2, NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS);
    limit = min(limit, 256u); // nghttp2's own queue would hold more; keeping them here keeps the urgency order
    return c.streams.size() >= limit ? 0 : limit - c.streams.size();
}

// Opens a stream for `request` (the bytes leave with the next h2_send). False when the session cannot take it.
static bool h2_start(Connection& c, NonnullRefPtr<Request> request)
{
    auto& r = *request;
    auto const& url = r.spec.url;
    r.head = r.spec.method.equals_ignoring_ascii_case("HEAD"sv);
    r.timing.h2 = true;
    if (r.timing.request_start_ms == 0)
        r.timing.request_start_ms = now_ms();
    r.body_sent = 0;
    r.headers_done = false;
    r.saw_response_byte = false;
    auto target = request_target(url);
    auto host = authority(url);
    auto scheme = url.scheme().to_byte_string();
    Vector<Header> fields;
    fields.append({ ":method", r.spec.method });
    fields.append({ ":scheme", scheme });
    fields.append({ ":authority", host });
    fields.append({ ":path", target });
    bool has_priority = false;
    for (auto& h : outgoing_headers(r, false)) {
        if (h.name.equals_ignoring_ascii_case("priority"sv))
            has_priority = true;
        fields.append({ h.name.to_lowercase(), h.value });
    }
    if (!has_priority) {
        if (auto priority = priority_field(r.spec); !priority.is_empty())
            fields.append({ "priority", priority });
    }
    Vector<nghttp2_nv> nv;
    for (auto& f : fields) {
        nv.append({ const_cast<u8*>(reinterpret_cast<u8 const*>(f.name.characters())), const_cast<u8*>(reinterpret_cast<u8 const*>(f.value.characters())),
            f.name.length(), f.value.length(), NGHTTP2_NV_FLAG_NONE });
    }
    nghttp2_data_provider2 provider {};
    provider.source.ptr = &r;
    provider.read_callback = h2_read_body;
    auto stream_id = nghttp2_submit_request2(c.h2, nullptr, nv.data(), nv.size(), r.spec.body.is_empty() ? nullptr : &provider, &r);
    if (stream_id < 0)
        return false;
    r.stream_id = stream_id;
    r.started_ms = now_ms();
    c.last_activity_ms = r.started_ms;
    c.streams.set(stream_id, request);
    c.streams_opened++;
    s_stats.h2_streams++;
    return true;
}

// Sends what nghttp2 has queued. False when the connection went away (a write the host answered by closing, or a session
// error, which closes it here).
static bool h2_send(Connection& c)
{
    if (!c.h2)
        return true;
    Vector<u8> out;
    for (;;) {
        u8 const* data = nullptr;
        auto n = nghttp2_session_mem_send2(c.h2, &data);
        if (n < 0) {
            close_connection(c, ByteString::formatted("HTTP/2 error: {}", nghttp2_strerror(static_cast<int>(n))));
            return false;
        }
        if (n == 0)
            break;
        out.append(data, static_cast<size_t>(n));
    }
    if (out.is_empty())
        return true;
    return send_plain(c, out);
}

// Requeues a request at the front of its origin's queue, or reports the failure.
static void requeue_or_fail(NonnullRefPtr<Request> const& request, bool retry, ByteString const& reason)
{
    auto& r = *request;
    if (r.done)
        return;
    r.stream_id = 0;
    if (retry) {
        r.headers_done = false;
        r.headers = nullptr;
        r.decoder = nullptr;
        s_pools.ensure(r.key).waiting.prepend(request);
        return;
    }
    s_stats.failures++;
    r.done = true;
    if (r.sink.on_complete)
        r.sink.on_complete(false, reason);
}

// A stream ended. Retries follow RFC 9113 section 8.7: a request the server refused (REFUSED_STREAM) or never took (above the
// GOAWAY's last stream id) was not processed and is retried whatever its method; HTTP_1_1_REQUIRED retries it over HTTP/1.1;
// anything else that ended before a response is retried once if it is idempotent, as the HTTP/1.1 path does.
static void h2_stream_closed(Connection& c, NonnullRefPtr<Request> const& request, u32 error)
{
    auto& r = *request;
    c.streams.remove(r.stream_id);
    if (r.done)
        return;
    if (error == NGHTTP2_NO_ERROR && r.headers_done) {
        r.done = true;
        s_stats.completed++;
        complete_ok(r);
        return;
    }
    bool unprocessed = error == NGHTTP2_REFUSED_STREAM || (c.draining && r.stream_id > c.goaway_last_stream_id);
    if (error == NGHTTP2_HTTP_1_1_REQUIRED) {
        s_h1_only.set(r.key);
        s_speaks_h2.set(r.key, false);
        unprocessed = !r.headers_done;
    }
    if (unprocessed && r.refusals < 3) {
        r.refusals++;
        requeue_or_fail(request, true, {});
        return;
    }
    if (!r.saw_response_byte && is_idempotent(r) && !r.retried) {
        r.retried = true;
        requeue_or_fail(request, true, {});
        return;
    }
    auto reason = ByteString::formatted("the server reset the HTTP/2 stream ({})", nghttp2_http2_strerror(error));
    requeue_or_fail(request, false, reason);
}

// Delivers what nghttp2's callbacks recorded, in order.
static void h2_deliver(Connection& c)
{
    auto id = c.id;
    auto generation = s_generation;
    while (!c.h2_events.is_empty()) {
        auto event = c.h2_events.take_first();
        auto& r = *event.request;
        switch (event.kind) {
        case H2Event::Kind::Headers:
            if (!r.done && r.sink.on_headers)
                r.sink.on_headers(r.status, {}, *r.headers);
            break;
        case H2Event::Kind::Data: {
            if (r.done || r.framing == Request::Framing::None)
                break;
            ByteString error;
            if (!deliver_body(r, event.data, error)) {
                // The stream stays in c.streams until nghttp2 reports it closed: nghttp2 holds a raw pointer to the request.
                if (alive(id, &c) && generation == s_generation && c.h2)
                    nghttp2_submit_rst_stream(c.h2, NGHTTP2_FLAG_NONE, r.stream_id, NGHTTP2_CANCEL);
                requeue_or_fail(event.request, false, error);
            }
            break;
        }
        case H2Event::Kind::Closed:
            h2_stream_closed(c, event.request, event.error);
            break;
        }
        if (generation != s_generation || !alive(id, &c))
            return;
    }
    if (!h2_send(c))
        return;
    if (c.draining && c.streams.is_empty()) {
        close_connection(c, "the server sent GOAWAY"); // dispatches what waits
        return;
    }
    if (!nghttp2_session_want_read(c.h2) && !nghttp2_session_want_write(c.h2)) {
        close_connection(c, "the HTTP/2 session ended");
        return;
    }
    dispatch_all();
}

static void h2_receive(Connection& c, ReadonlyBytes plain)
{
    auto rv = nghttp2_session_mem_recv2(c.h2, plain.data(), plain.size());
    if (rv < 0) {
        // A connection error (RFC 9113 section 5.4.1): nghttp2 queued a GOAWAY; it goes out, then the connection.
        auto id = c.id;
        auto message = ByteString::formatted("HTTP/2 protocol error: {}", nghttp2_strerror(static_cast<int>(rv)));
        c.h2_events.clear();
        if (!h2_send(c) || !alive(id, &c))
            return;
        close_connection(c, message);
        return;
    }
    h2_deliver(c);
}

// An idle HTTP/2 connection goes with a GOAWAY (NO_ERROR), as RFC 9113 section 6.8 asks of an endpoint that closes.
static void h2_close_idle(Connection& c)
{
    nghttp2_session_terminate_session(c.h2, NGHTTP2_NO_ERROR);
    auto id = c.id;
    if (!h2_send(c) || !alive(id, &c))
        return;
    close_connection(c, "idle");
}

// The connection's own pool, or the pool its first request came from.
static void on_ready(Connection& c)
{
    auto id = c.id;
    c.state = Connection::State::Ready;
    // The request that opened the connection has its connect phase (Resource Timing); later ones ride it reused.
    if (c.current && c.current->timing.request_start_ms == 0) {
        auto& t = c.current->timing;
        t.connect_start_ms = c.opened_ms;
        t.secure_connect_start_ms = c.tls_start_ms;
        t.connect_end_ms = now_ms();
        t.request_start_ms = t.connect_end_ms;
    }
    if (c.tls && c.offer_h2) {
        bool h2 = c.session->alpn() == "h2"sv;
        s_speaks_h2.set(c.key, h2);
        if (h2) {
            if (!h2_begin(c)) {
                fail_request(c, "HTTP/2 session could not start");
                return;
            }
            auto first = c.current;
            c.current = nullptr;
            if (first && !h2_start(c, *first))
                requeue_or_fail(*first, true, {});
            if (!h2_send(c) || !alive(id, &c))
                return;
            dispatch_all();
            return;
        }
    }
    c.protocol = Connection::Protocol::Http1;
    if (c.current && c.pending_plain.is_empty() && !c.current->tunnel) {
        auto first = c.current;
        start_request(c, *first, false);
    } else if (!c.pending_plain.is_empty()) {
        auto pending = move(c.pending_plain);
        c.pending_plain = {};
        send_plain(c, pending);
    }
    if (!alive(id, &c))
        return;
    dispatch(c.key); // with the protocol known, the pool may open its other connections
}

// --- Pools ---------------------------------------------------------------------------------------------------------------

// A new connection for `request`, which rides it from the start (the pool's counts stay honest). The
// request is on the connection before the host hears of it: a host that answers synchronously, by
// opening, closing or even completing the stream inside ganglion_host_tcp_connect, finds a connection
// that knows its request. Nothing here touches the connection after that call: it may be gone.
// The request's bytes wait for the protocol (ALPN decides between HTTP/1.1 and HTTP/2), except a tunnel's,
// which is HTTP/1.1 whatever happens.
static void open_connection(ByteString const& key, NonnullRefPtr<Request> request)
{
    auto const& url = request->spec.url;
    bool request_is_sync = request->sync;
    auto* c = new Connection;
    c->id = s_next_stream_id++;
    c->key = key;
    c->host = bare_host(url);
    c->port = url.port_or_default();
    c->tls = url.scheme() == "https"sv;
    c->offer_h2 = c->tls && !request->tunnel && !request->sync && !s_h1_only.contains(request->key);
    c->opened_ms = c->last_activity_ms = now_ms();
    c->sync = request->sync;
    s_by_stream.set(c->id, c);
    s_pools.ensure(key).connections.append(c);
    s_stats.connections++;
    ensure_timer();
    c->current = request;
    request->started_ms = c->opened_ms;
    if (request->tunnel)
        start_request(*c, move(request), false); // queued in pending_plain until the stream opens
    auto id = c->id;
    auto host = c->host;
    auto port = c->port;
    if (request_is_sync)
        ganglion_host_tcp_connect_sync(id, host.characters(), host.length(), port);
    else
        ganglion_host_tcp_connect(id, host.characters(), host.length(), port);
}

// Connection pooling as Chrome does it (SpdySessionPool's IP pooling): an HTTP/2 connection to another host serves this
// origin when the host's name resolves to the address that connection is connected to (same port), and the connection's
// certificate is valid for this host. Needs both the host's name resolution and the connection's address from the host;
// without them nothing is pooled.
static Connection* pooled_connection(URL::URL const& url)
{
    if (url.scheme() != "https"sv)
        return nullptr;
    auto host = bare_host(url);
    auto port = url.port_or_default();
    Vector<ByteString> addresses;
    if (url.host().has_value() && !url.host()->is_domain())
        addresses.append(host);
    else if (auto answer = s_dns.get(host); answer.has_value())
        addresses = *answer;
    if (addresses.is_empty())
        return nullptr;
    for (auto& [id, c] : s_by_stream) {
        if (c->protocol != Connection::Protocol::Http2 || c->state != Connection::State::Ready || c->draining || !c->tls || c->port != port)
            continue;
        if (c->peer_address.is_empty() || !addresses.contains_slow(c->peer_address) || c->host == host)
            continue;
        if (!c->session->certificate_covers(host))
            continue;
        return c;
    }
    return nullptr;
}

static Connection* h2_connection_for(Pool& pool, URL::URL const& url)
{
    for (auto* c : pool.connections) {
        if (c->protocol == Connection::Protocol::Http2 && c->state == Connection::State::Ready && !c->draining)
            return c;
    }
    return pooled_connection(url);
}

// The waiting request to send next: the most urgent, first come first served within an urgency (RFC 9218 urgency 0 first).
static NonnullRefPtr<Request> take_next(Pool& pool)
{
    size_t best = 0;
    for (size_t i = 1; i < pool.waiting.size(); i++) {
        if (pool.waiting[i]->spec.urgency < pool.waiting[best]->spec.urgency)
            best = i;
    }
    return pool.waiting.take(best);
}

// Starts waiting requests on idle or new connections of one origin. Re-entrant calls (a request that
// completes or fails inside start_request or open_connection, a host answering synchronously) are
// deferred to the outer call: the pool is looked up afresh for every request, and no reference into
// s_pools or into a connection outlives a callback. The owner's run of 2026-10-11 died in this loop's
// Vector::remove after a callback had drained the queue under it.
static bool s_dispatching { false };
static Vector<ByteString> s_dispatch_again;

static void dispatch_one(ByteString const& key)
{
    for (;;) {
        auto it = s_pools.find(key);
        if (it == s_pools.end())
            return;
        auto& pool = it->value;
        if (pool.waiting.is_empty())
            return;
        // HTTP/2: as many streams as the server allows on the origin's connection (or a pooled one), most urgent first.
        if (!pool.waiting.first()->tunnel && !s_h1_only.contains(key)) {
            if (auto* h2 = h2_connection_for(pool, pool.waiting.first()->spec.url)) {
                auto id = h2->id;
                if (h2->key != key)
                    s_stats.h2_pooled++;
                bool started = false;
                while (!pool.waiting.is_empty() && h2_free_streams(*h2) > 0) {
                    auto request = take_next(pool);
                    if (!h2_start(*h2, request)) {
                        h2->draining = true; // out of stream ids, or the session is going: a new connection takes the rest
                        pool.waiting.prepend(move(request));
                        break;
                    }
                    started = true;
                }
                if (started && (!h2_send(*h2) || !alive(id, h2)))
                    continue;
                if (!h2->draining)
                    return; // the rest wait for streams to close
                continue;
            }
        }
        Connection* idle = nullptr;
        for (auto* c : pool.connections) {
            if (c->state == Connection::State::Ready && c->protocol == Connection::Protocol::Http1 && !c->current && !c->tunnel && !c->sync) {
                idle = c;
                break;
            }
        }
        if (idle) {
            auto request = take_next(pool);
            start_request(*idle, move(request), true);
            continue;
        }
        // A connection still connecting will take a waiting request when it opens.
        size_t connecting = 0;
        for (auto* c : pool.connections)
            if (c->state != Connection::State::Ready && !c->current)
                connecting++;
        if (connecting >= pool.waiting.size())
            return;
        // An https origin that may speak HTTP/2 (it did last time, or it is new) gets one connection until its ALPN answer is
        // known: the requests behind the first then share it as streams instead of opening five more TLS connections.
        bool may_speak_h2 = key.starts_with("https:"sv) && !s_h1_only.contains(key) && s_speaks_h2.get(key).value_or(true);
        if (may_speak_h2) {
            bool negotiating = false;
            for (auto* c : pool.connections) {
                if (c->state != Connection::State::Ready && c->offer_h2)
                    negotiating = true;
            }
            if (negotiating)
                return;
        }
        size_t usable = 0;
        for (auto* c : pool.connections)
            if (!c->draining)
                usable++;
        if (usable >= MAX_CONNECTIONS_PER_ORIGIN)
            return;
        if (s_by_stream.size() >= MAX_CONNECTIONS_TOTAL) {
            // `pool` is not used past a close: the loop looks the pool up again.
            if (close_one_idle_connection())
                continue;
            s_waiting_for_room = true;
            return;
        }
        auto request = take_next(pool);
        open_connection(key, move(request));
    }
}

static void dispatch(ByteString const& requested)
{
    if (s_dispatching) {
        if (!s_dispatch_again.contains_slow(requested))
            s_dispatch_again.append(requested);
        return;
    }
    s_dispatching = true;
    ByteString key = requested; // the caller's string may belong to a connection that goes away
    for (;;) {
        dispatch_one(key);
        if (s_dispatch_again.is_empty())
            break;
        key = s_dispatch_again.take_first();
    }
    s_dispatching = false;
}

// Every pool with waiting requests (an HTTP/2 connection freed streams that requests of several origins may wait for).
static void dispatch_all()
{
    Vector<ByteString> keys;
    for (auto& [key, pool] : s_pools) {
        if (!pool.waiting.is_empty())
            keys.append(key);
    }
    for (auto& key : keys)
        dispatch(key);
}

void submit(RequestSpec spec, Sink sink)
{
    auto request = adopt_ref(*new Request);
    request->spec = move(spec);
    request->sink = move(sink);
    request->timing.submitted_ms = now_ms();
    request->key = origin_key(request->spec.url);
    request->order = s_next_order++;
    s_stats.requests++;
    // Inside a nested wait the host cannot deliver an ordinary stream's events (its thread is blocked under this call), so
    // the request gets a synchronous connection of its own (HTTP/1.1), outside the pool's queue and never reused.
    if (g_nested_pumps > 0) {
        request->sync = true;
        open_connection(request->key, request);
        return;
    }
    s_pools.ensure(request->key).waiting.append(request);
    dispatch(request->key);
}

void set_dns_answer(ByteString const& host, Vector<ByteString> addresses)
{
    if (addresses.is_empty())
        s_dns.remove(host);
    else
        s_dns.set(host, move(addresses));
}

void tcp_peer(u32 stream_id, ByteString const& address)
{
    if (auto it = s_by_stream.find(stream_id); it != s_by_stream.end())
        it->value->peer_address = address;
}

// Hands bytes to the host. A host may answer inside the call (open, deliver, close the stream), and a close deletes
// the connection: the counters are updated first, and the result says whether `c` is still there. Nothing may touch
// `c` after a false (the owner-visible symptom was a Rust paint-thread panic with a garbage index: the old code
// added to c.bytes_out after the write, a store into freed memory that the allocator had already given away).
static bool host_write(Connection& c, u8 const* data, size_t size)
{
    auto id = c.id;
    c.bytes_out += size;
    s_stats.bytes_sent += size;
    ganglion_host_tcp_write(id, data, size);
    return alive(id, &c);
}

// False when the connection went away.
static bool send_plain(Connection& c, ReadonlyBytes bytes)
{
    if (c.state != Connection::State::Ready) {
        c.pending_plain.append(bytes.data(), bytes.size());
        return true;
    }
    if (!c.tls)
        return host_write(c, bytes.data(), bytes.size());
    size_t written = 0;
    auto result = c.session->write(bytes, written);
    Vector<u8> out;
    c.session->drain(out);
    if (!out.is_empty() && !host_write(c, out.data(), out.size()))
        return false;
    if (result.is_error()) {
        fail_request(c, ByteString::formatted("{}", result.error()));
        return false;
    }
    if (written < bytes.size())
        c.pending_plain.append(bytes.data() + written, bytes.size() - written);
    return true;
}

static void remove_from_pool(Connection& c)
{
    s_by_stream.remove(c.id);
    if (auto it = s_pools.find(c.key); it != s_pools.end())
        it->value.connections.remove_all_matching([&](auto* x) { return x == &c; });
    if (c.key.starts_with("tunnel:"sv))
        s_pools.remove(c.key); // one connection per tunnel key
}

// The tunnel is over (once): its user hears why, unless the user closed it.
static void tunnel_finish(NonnullRefPtr<TunnelState> const& tunnel, ByteString const& error)
{
    if (tunnel->closed)
        return;
    tunnel->closed = true;
    s_tunnels.remove(tunnel->id);
    if (tunnel->sink.on_close)
        tunnel->sink.on_close(error);
}

static void close_connection(Connection& c, ByteString const& reason, bool tell_host)
{
    if (c.state == Connection::State::Closed)
        return;
    c.state = Connection::State::Closed;
    remove_from_pool(c);
    if (tell_host)
        ganglion_host_tcp_close(c.id);
    auto key = c.key;
    auto tunnel = c.tunnel;
    // A request still on the connection is never dropped without a word: one that saw no response byte goes back to the
    // front of the queue (a new connection takes it), any other fails with the reason.
    auto request = c.current;
    c.current = nullptr;
    // HTTP/2 streams still open: one the server never took (above its GOAWAY's last stream id) is retried whatever its
    // method; one without a response byte is retried once if idempotent; the others fail.
    Vector<NonnullRefPtr<Request>> streams;
    for (auto& [stream_id, r] : c.streams)
        streams.append(r);
    quick_sort(streams, [](auto const& a, auto const& b) { return a->stream_id < b->stream_id; });
    bool draining = c.draining;
    i32 last_stream_id = c.goaway_last_stream_id;
    c.streams.clear();
    c.h2_events.clear();
    delete &c;
    if (tunnel)
        tunnel_finish(*tunnel, reason);
    if (request && !request->done && !(request->tunnel && request->tunnel->closed)) {
        if (!request->saw_response_byte && !request->retried) {
            request->retried = true;
            if (request->sync) {
                open_connection(key, *request);
                return;
            }
            s_pools.ensure(key).waiting.prepend(*request);
        } else {
            s_stats.failures++;
            request->done = true;
            if (request->sink.on_complete)
                request->sink.on_complete(false, reason);
        }
    }
    for (size_t i = streams.size(); i-- > 0;) {
        auto& r = streams[i];
        if (r->done)
            continue;
        if (draining && r->stream_id > last_stream_id && r->refusals < 3) {
            r->refusals++;
            requeue_or_fail(r, true, {});
        } else if (!r->saw_response_byte && !r->retried && is_idempotent(*r)) {
            r->retried = true;
            requeue_or_fail(r, true, {});
        } else {
            requeue_or_fail(r, false, reason);
        }
    }
    dispatch(key);
    if (!streams.is_empty() || s_waiting_for_room) {
        s_waiting_for_room = false;
        dispatch_all();
    }
}

// The current request ends in failure (or is retried once, when a reused connection died before
// answering), and the connection goes.
static void fail_request(Connection& c, ByteString const& message)
{
    auto request = c.current;
    c.current = nullptr;
    auto key = c.key;
    bool reused = c.reused;
    close_connection(c, message); // deletes the connection
    if (!request)
        return;
    if (reused && !request->saw_response_byte && !request->retried && request->spec.method.is_one_of("GET"sv, "HEAD"sv)) {
        request->retried = true;
        s_pools.ensure(key).waiting.prepend(*request);
        dispatch(key);
        return;
    }
    s_stats.failures++;
    request->done = true;
    if (request->sink.on_complete)
        request->sink.on_complete(false, message);
}

static void complete_ok(Request& request)
{
    request.timing.response_end_ms = now_ms();
    if (request.sink.on_timing)
        request.sink.on_timing(request.timing);
    if (request.sink.on_complete)
        request.sink.on_complete(true, {});
}

static void finish_request(Connection& c)
{
    auto request = c.current;
    c.current = nullptr;
    c.last_activity_ms = now_ms();
    request->done = true;
    s_stats.completed++;
    // Whether the connection can carry another request is settled before the page hears of this one: the completion runs
    // the page (a parser that resumes, a script that inserts <script src>), and a request it makes at once looks for an
    // idle connection. One the server is closing (Connection: close; Cloudflare's 403 interstitial) must not be found:
    // the request rode it, the close then deleted it, and the request was never sent nor failed (the parser's end waited
    // on it for ever: "HTMLParserEndState: timed out in phase 2", a blank page).
    if (!c.keep_alive || c.sync || (c.session && c.session->peer_closed)) {
        close_connection(c, "server asked for close"); // deletes the connection
        if (request->sink.on_complete)
            complete_ok(*request);
        return;
    }
    // Bytes beyond the response (a pipelining server, or garbage) would confuse the next request.
    if (!c.rx.is_empty())
        c.rx.clear();
    auto key = c.key;
    auto generation = s_generation;
    if (request->sink.on_complete)
        complete_ok(*request);
    if (generation != s_generation)
        return;
    dispatch(key);
}

// --- Response parsing -------------------------------------------------------------------------------------

static Optional<u64> parse_hex(StringView text)
{
    if (text.is_empty() || text.length() > 16)
        return {};
    u64 value = 0;
    for (char ch : text) {
        u8 digit;
        if (ch >= '0' && ch <= '9')
            digit = ch - '0';
        else if (ch >= 'a' && ch <= 'f')
            digit = 10 + ch - 'a';
        else if (ch >= 'A' && ch <= 'F')
            digit = 10 + ch - 'A';
        else
            return {};
        value = (value << 4) | digit;
    }
    return value;
}

static Optional<size_t> find_header_end(Vector<u8> const& rx)
{
    for (size_t i = 0; i + 3 < rx.size(); i++) {
        if (rx[i] == '\r' && rx[i + 1] == '\n' && rx[i + 2] == '\r' && rx[i + 3] == '\n')
            return i + 4;
    }
    return {};
}

// Parses the status line and headers in rx[0, end). Returns false on a malformed message.
static bool parse_head(Connection& c, Request& r, size_t end)
{
    StringView head { reinterpret_cast<char const*>(c.rx.data()), end };
    auto lines = head.lines(StringView::ConsiderCarriageReturn::Yes);
    if (lines.is_empty())
        return false;
    auto status_line = lines[0];
    if (!status_line.starts_with("HTTP/1."sv) || status_line.length() < 12)
        return false;
    bool http10 = status_line[7] == '0';
    auto code = status_line.substring_view(9, 3).to_number<u32>();
    if (!code.has_value())
        return false;
    r.status = *code;
    r.reason = status_line.length() > 13 ? ByteString(status_line.substring_view(13)) : ByteString();
    r.headers = HTTP::HeaderList::create();
    for (size_t i = 1; i < lines.size(); i++) {
        auto line = lines[i];
        if (line.is_empty())
            continue;
        auto colon = line.find(':');
        if (!colon.has_value() || *colon == 0)
            continue;
        auto name = line.substring_view(0, *colon).trim_whitespace();
        auto value = line.substring_view(*colon + 1).trim_whitespace();
        r.headers->append(HTTP::Header::isomorphic_encode(name, value));
    }
    // Framing (RFC 9112 section 6.3).
    c.keep_alive = !http10;
    if (auto connection = r.headers->get("Connection"sv); connection.has_value()) {
        auto v = StringView(*connection);
        if (v.contains("close"sv, CaseSensitivity::CaseInsensitive))
            c.keep_alive = false;
        else if (v.contains("keep-alive"sv, CaseSensitivity::CaseInsensitive))
            c.keep_alive = true;
    }
    if (r.head || r.status == 204 || r.status == 304 || (r.status >= 100 && r.status < 200)) {
        r.framing = Request::Framing::None;
    } else if (auto te = r.headers->get("Transfer-Encoding"sv); te.has_value() && StringView(*te).contains("chunked"sv, CaseSensitivity::CaseInsensitive)) {
        r.framing = Request::Framing::Chunked;
        r.chunk_state = Request::ChunkState::Size;
    } else if (auto cl = r.headers->get("Content-Length"sv); cl.has_value()) {
        auto n = StringView(*cl).trim_whitespace().to_number<u64>();
        if (!n.has_value())
            return false;
        r.framing = Request::Framing::ContentLength;
        r.remaining = *n;
    } else {
        r.framing = Request::Framing::UntilClose;
        c.keep_alive = false;
    }
    if (auto ce = r.headers->get("Content-Encoding"sv); ce.has_value() && r.framing != Request::Framing::None)
        r.decoder = Decoder::for_encoding(*ce);
    return true;
}

static bool deliver_body(Request& r, ReadonlyBytes bytes, ByteString& error)
{
    if (bytes.is_empty())
        return true;
    r.timing.encoded_body_bytes += bytes.size();
    if (!r.decoder) {
        if (r.sink.on_data)
            r.sink.on_data(bytes);
        return true;
    }
    auto result = r.decoder->push(bytes, [&](ReadonlyBytes out) {
        if (r.sink.on_data)
            r.sink.on_data(out);
    });
    if (result.is_error()) {
        error = ByteString::formatted("{}", result.error());
        return false;
    }
    return true;
}

// Consumes what it can of c.rx for the current request. Returns false when the connection must go.
static void on_plaintext(Connection& c)
{
    auto generation = s_generation;
    if (c.tunnel) {
        // The upgraded protocol's bytes: handed over as they come.
        Vector<u8> bytes = move(c.rx);
        c.rx = {};
        auto tunnel = c.tunnel;
        if (!bytes.is_empty() && tunnel->sink.on_data && !tunnel->closed)
            tunnel->sink.on_data(bytes.span());
        return;
    }
    while (c.current && !c.rx.is_empty()) {
        auto request = c.current;
        auto& r = *request;
        if (!r.saw_response_byte)
            r.timing.response_start_ms = now_ms();
        r.saw_response_byte = true;
        c.last_activity_ms = now_ms();
        if (!r.headers_done) {
            auto end = find_header_end(c.rx);
            if (!end.has_value()) {
                if (c.rx.size() > MAX_HEADER_BLOCK)
                    fail_request(c, "the response headers are too large");
                return;
            }
            if (!parse_head(c, r, *end)) {
                fail_request(c, "malformed HTTP response");
                return;
            }
            c.rx.remove(0, *end);
            if (r.tunnel && (r.status == 101 || r.status >= 200)) {
                if (r.status != 101) {
                    fail_request(c, ByteString::formatted("the server answered HTTP {} {} to the upgrade", r.status, r.reason));
                    return;
                }
                // Switching protocols: the connection is the tunnel's from here on.
                auto tunnel = r.tunnel;
                auto stream_id = c.id;
                c.tunnel = tunnel;
                c.current = nullptr;
                c.keep_alive = false;
                request->done = true;
                s_stats.completed++;
                if (tunnel->sink.on_open)
                    tunnel->sink.on_open(r.status, r.reason, *r.headers);
                if (generation != s_generation || s_by_stream.get(stream_id) != &c || tunnel->closed)
                    return;
                on_plaintext(c); // what followed the 101 in the same read
                return;
            }
            if (r.status >= 100 && r.status < 200) {
                // 100 Continue, 103 Early Hints: informational; the real response follows.
                r.headers = nullptr;
                continue;
            }
            r.headers_done = true;
            if (r.sink.on_headers)
                r.sink.on_headers(r.status, r.reason, *r.headers);
            if (generation != s_generation || c.current != request)
                return;
            // No body (HEAD, 204, 304) or an empty one (Content-Length: 0): the response is complete now;
            // the loop below only runs on body bytes, of which there are none.
            if (r.framing == Request::Framing::None || (r.framing == Request::Framing::ContentLength && r.remaining == 0)) {
                finish_request(c);
                return;
            }
            continue;
        }
        ByteString error;
        if (r.framing == Request::Framing::ContentLength) {
            size_t take = min(static_cast<u64>(c.rx.size()), r.remaining);
            auto bytes = ReadonlyBytes { c.rx.data(), take };
            if (!deliver_body(r, bytes, error)) {
                fail_request(c, error);
                return;
            }
            if (generation != s_generation || c.current != request)
                return;
            c.rx.remove(0, take);
            r.remaining -= take;
            if (r.remaining == 0) {
                finish_request(c);
                return;
            }
            return;
        }
        if (r.framing == Request::Framing::UntilClose) {
            auto bytes = ReadonlyBytes { c.rx.data(), c.rx.size() };
            Vector<u8> copy;
            copy.append(bytes.data(), bytes.size());
            c.rx.clear_with_capacity();
            if (!deliver_body(r, copy, error)) {
                fail_request(c, error);
                return;
            }
            return;
        }
        // Chunked.
        if (r.chunk_state == Request::ChunkState::Size) {
            // "<hex>[;ext]\r\n"
            size_t i = 0;
            while (i + 1 < c.rx.size() && !(c.rx[i] == '\r' && c.rx[i + 1] == '\n'))
                i++;
            if (i + 1 >= c.rx.size()) {
                if (c.rx.size() > 1024) {
                    fail_request(c, "malformed chunk size");
                }
                return;
            }
            StringView line { reinterpret_cast<char const*>(c.rx.data()), i };
            auto semicolon = line.find(';');
            auto hex = (semicolon.has_value() ? line.substring_view(0, *semicolon) : line).trim_whitespace();
            auto size = parse_hex(hex);
            if (!size.has_value()) {
                fail_request(c, "malformed chunk size");
                return;
            }
            c.rx.remove(0, i + 2);
            r.remaining = *size;
            r.chunk_state = *size == 0 ? Request::ChunkState::Trailers : Request::ChunkState::Data;
            continue;
        }
        if (r.chunk_state == Request::ChunkState::Data) {
            size_t take = min(static_cast<u64>(c.rx.size()), r.remaining);
            Vector<u8> copy;
            copy.append(c.rx.data(), take);
            c.rx.remove(0, take);
            r.remaining -= take;
            if (r.remaining == 0)
                r.chunk_state = Request::ChunkState::DataCRLF;
            if (!deliver_body(r, copy, error)) {
                fail_request(c, error);
                return;
            }
            if (generation != s_generation || c.current != request)
                return;
            continue;
        }
        if (r.chunk_state == Request::ChunkState::DataCRLF) {
            if (c.rx.size() < 2)
                return;
            c.rx.remove(0, 2);
            r.chunk_state = Request::ChunkState::Size;
            continue;
        }
        // Trailers: lines until an empty one.
        {
            size_t i = 0;
            bool found = false;
            while (i + 1 < c.rx.size()) {
                if (c.rx[i] == '\r' && c.rx[i + 1] == '\n') {
                    if (i == 0) {
                        c.rx.remove(0, 2);
                        found = true;
                        break;
                    }
                    // a trailer line: skip it (nothing consumes trailers)
                    c.rx.remove(0, i + 2);
                    i = 0;
                    continue;
                }
                i++;
            }
            if (!found)
                return;
            finish_request(c);
            return;
        }
    }
}

// --- Events from the host -----------------------------------------------------------------------------------

void tcp_opened(u32 stream_id)
{
    auto it = s_by_stream.find(stream_id);
    if (it == s_by_stream.end())
        return;
    auto& c = *it->value;
    c.last_activity_ms = now_ms();
    if (!c.tls) {
        on_ready(c);
        return;
    }
    c.tls_start_ms = c.last_activity_ms;
    c.session = adopt_own(*new TlsSession);
    if (auto r = c.session->start(c.host, c.port, c.offer_h2); r.is_error()) {
        fail_request(c, ByteString::formatted("{}", r.error()));
        return;
    }
    c.state = Connection::State::Handshaking;
    auto step = c.session->handshake();
    Vector<u8> out;
    c.session->drain(out);
    if (!out.is_empty() && !host_write(c, out.data(), out.size()))
        return;
    if (step.is_error())
        fail_request(c, ByteString::formatted("{}", step.error()));
}

void tcp_data(u32 stream_id, ReadonlyBytes bytes)
{
    auto it = s_by_stream.find(stream_id);
    if (it == s_by_stream.end())
        return;
    auto& c = *it->value;
    c.bytes_in += bytes.size();
    s_stats.bytes_received += bytes.size();
    c.last_activity_ms = now_ms();
    if (!c.tls) {
        c.rx.append(bytes.data(), bytes.size());
        on_plaintext(c);
        return;
    }
    c.session->feed(bytes);
    if (c.state == Connection::State::Handshaking) {
        auto step = c.session->handshake();
        Vector<u8> out;
        c.session->drain(out);
        if (!out.is_empty() && !host_write(c, out.data(), out.size()))
            return;
        if (step.is_error()) {
            fail_request(c, ByteString::formatted("{}", step.error()));
            return;
        }
        if (!step.value())
            return;
        s_stats.tls_handshakes++;
        s_stats.tls_handshake_ms += now_ms() - c.session->handshake_started_ms;
        s_stats.tls_handshake_cpu_ms += c.session->handshake_cpu_ms;
        on_ready(c);
        // The first bytes may have been answered and closed synchronously: `c` could be gone.
        if (auto again = s_by_stream.find(stream_id); again == s_by_stream.end() || again->value != &c || c.state != Connection::State::Ready)
            return;
    }
    Vector<u8> plain;
    auto r = c.session->read(plain);
    Vector<u8> out;
    c.session->drain(out);
    if (!out.is_empty() && !host_write(c, out.data(), out.size()))
        return;
    if (r.is_error()) {
        fail_request(c, ByteString::formatted("{}", r.error()));
        return;
    }
    if (!plain.is_empty()) {
        if (c.protocol == Connection::Protocol::Http2) {
            h2_receive(c, plain);
        } else {
            c.rx.append(plain.data(), plain.size());
            on_plaintext(c);
        }
        if (s_by_stream.get(stream_id) != &c)
            return;
    }
    if (c.session->peer_closed)
        tcp_closed(stream_id, 0);
}

// The host's reason for a closed stream, in Wisp's close-reason numbers (protocol.md), as the user
// should read it; 0 is a plain end of stream.
static ByteString close_reason_text(u32 reason)
{
    switch (reason) {
    case 0x41: return "the relay refused the destination as invalid";
    case 0x42: return "host not found";
    case 0x43: return "the connection timed out";
    case 0x44: return "the connection was refused";
    case 0x47: return "the connection was idle too long";
    case 0x48: return "destination blocked by the relay";
    case 0x49: return "throttled by the relay";
    case 0xc0: case 0xc1: case 0xc2: return "the relay refused the credentials";
    default: return {};
    }
}

void tcp_closed(u32 stream_id, u32 reason)
{
    auto it = s_by_stream.find(stream_id);
    if (it == s_by_stream.end())
        return;
    auto& c = *it->value;
    if (c.protocol == Connection::Protocol::Http2) {
        auto why = close_reason_text(reason);
        close_connection(c, !why.is_empty() ? why : ByteString("the connection closed before the response ended"), false);
        return;
    }
    if (c.current) {
        auto& r = *c.current;
        if (r.headers_done && r.framing == Request::Framing::UntilClose) {
            remove_from_pool(c);
            c.state = Connection::State::Closed;
            auto request = c.current;
            c.current = nullptr;
            request->done = true;
            s_stats.completed++;
            auto key = c.key;
            delete &c;
            if (request->sink.on_complete)
                complete_ok(*request);
            dispatch(key);
            return;
        }
        // The close came from the host: do not tell it to close again.
        auto request = c.current;
        c.current = nullptr;
        bool reused = c.reused;
        auto key = c.key;
        c.state = Connection::State::Closed;
        remove_from_pool(c);
        delete &c;
        if (reused && !request->saw_response_byte && !request->retried && request->spec.method.is_one_of("GET"sv, "HEAD"sv)) {
            request->retried = true;
            s_pools.ensure(key).waiting.prepend(*request);
            dispatch(key);
            return;
        }
        s_stats.failures++;
        request->done = true;
        auto why = close_reason_text(reason);
        if (request->sink.on_complete)
            request->sink.on_complete(false, !why.is_empty() ? why : request->headers_done ? "the connection closed before the response ended" : "the connection closed before a response arrived");
        dispatch(key);
        return;
    }
    close_connection(c, c.tunnel ? close_reason_text(reason) : ByteString("closed by the host"), false);
}

// --- The document fetch ------------------------------------------------------------------------------------

extern "C" {
size_t ganglion_host_cookie_get(char const* url, size_t url_length, char const* context, size_t context_length, char** out);
void ganglion_host_cookie_set(char const* url, size_t url_length, char const* context, size_t context_length, char const* lines, size_t lines_length);
}

ByteString cookie_header(URL::URL const& url, StringView context)
{
    auto serialized = url.to_byte_string();
    char* out = nullptr;
    auto length = ganglion_host_cookie_get(serialized.characters(), serialized.length(), context.characters_without_null_termination(), context.length(), &out);
    if (!out)
        return {};
    ByteString header { out, length };
    free(out);
    return header;
}

void store_cookies(URL::URL const& url, HTTP::HeaderList const& headers, StringView context)
{
    StringBuilder lines;
    for (auto const& header : headers) {
        if (!header.name.equals_ignoring_ascii_case("set-cookie"sv))
            continue;
        if (!lines.is_empty())
            lines.append('\n');
        lines.append(header.value);
    }
    if (lines.is_empty())
        return;
    auto serialized = url.to_byte_string();
    auto text = lines.to_byte_string();
    ganglion_host_cookie_set(serialized.characters(), serialized.length(), context.characters_without_null_termination(), context.length(), text.characters(), text.length());
}

struct NavigationInitiator {
    URL::URL url;
    URL::Origin origin;
    bool user_activated { false };
    Vector<URL::Origin> redirected_from; // the URLs a redirect left, in order
};
static Optional<NavigationInitiator> s_next_navigation_initiator;

void set_next_navigation_initiator(URL::URL const& url, URL::Origin initiator, bool user_activated)
{
    s_next_navigation_initiator = NavigationInitiator { url, move(initiator), user_activated };
}

static ByteString s_document_referrer;
void set_document_referrer(ByteString referrer)
{
    s_document_referrer = move(referrer);
}

// https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy, for the hosts a request can reach
static bool is_potentially_trustworthy(URL::URL const& url)
{
    if (url.scheme() == "https"sv)
        return true;
    auto host = url.serialized_host();
    return host == "localhost"sv || host.ends_with(".localhost"sv) || host == "127.0.0.1"sv || host == "[::1]"sv;
}

// A top-level navigation's headers in Chrome's order (Chrome 154 for a typed URL: Sec-Fetch-Site none, User ?1; for a
// page's own navigation: its relation to the page, ?1 only with a user activation). Fetch Metadata only goes to
// potentially trustworthy URLs.
static Vector<Header> navigation_headers(URL::URL const& url, Optional<NavigationInitiator> const& initiator)
{
    Vector<Header> headers {
        { "Upgrade-Insecure-Requests", "1" },
        { "User-Agent", Web::ResourceLoader::the().user_agent_for_url(url).to_byte_string() },
        { "Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7" },
    };
    if (is_potentially_trustworthy(url)) {
        ByteString site = "none";
        bool user = true;
        if (initiator.has_value()) {
            // https://w3c.github.io/webappsec-fetch-metadata/#abstract-opdef-set-site: the worst relation over the URL list.
            int worst = 0;
            auto relate = [&](URL::Origin const& o) { worst = max(worst, initiator->origin.is_same_origin(o) ? 0 : initiator->origin.is_same_site(o) ? 1 : 2); };
            for (auto const& o : initiator->redirected_from)
                relate(o);
            relate(url.origin());
            site = worst == 0 ? "same-origin" : worst == 1 ? "same-site" : "cross-site";
            user = initiator->user_activated;
        }
        headers.append({ "Sec-Fetch-Site", site });
        headers.append({ "Sec-Fetch-Mode", "navigate" });
        if (user)
            headers.append({ "Sec-Fetch-User", "?1" });
        headers.append({ "Sec-Fetch-Dest", "document" });
    }
    headers.append({ "Accept-Language", "en-US,en;q=0.9" });
    return headers;
}

static void fetch_document_step(URL::URL url, ByteString method, int redirects_left, double started_ms, u32 redirect_count, Optional<NavigationInitiator> initiator, Function<void(DocumentResult)> done)
{
    struct State : public RefCounted<State> {
        DocumentResult result;
        ByteString method;
        int redirects_left;
        double started_ms;
        Function<void(DocumentResult)> done;
    };
    auto state = adopt_ref(*new State);
    state->result.url = url;
    state->result.started_ms = started_ms;
    state->result.redirect_count = redirect_count;
    state->method = method;
    state->redirects_left = redirects_left;
    state->started_ms = started_ms;
    state->done = move(done);
    RequestSpec spec;
    spec.method = method;
    spec.url = url;
    spec.headers = navigation_headers(url, initiator);
    spec.urgency = 0;
    if (!s_document_referrer.is_empty())
        spec.headers.append({ "Referer", s_document_referrer });
    // The top-level document: every hop of its redirect chain sends and stores cookies as a top-level navigation.
    auto cookie_context = ByteString::formatted("navigate-top\n{}", method);
    if (auto cookies = cookie_header(url, cookie_context); !cookies.is_empty())
        spec.headers.append({ "Cookie", move(cookies) });
    Sink sink;
    sink.on_headers = [state, url, cookie_context](u32 status, ByteString const&, NonnullRefPtr<HTTP::HeaderList> headers) {
        store_cookies(url, *headers, cookie_context);
        headers->delete_("Set-Cookie"sv);
        state->result.status = status;
        state->result.headers = headers;
    };
    sink.on_data = [state](ReadonlyBytes bytes) {
        state->result.body.append(bytes);
    };
    sink.on_timing = [state](Timing const& timing) {
        state->result.timing = timing;
    };
    sink.on_complete = [state, initiator](bool ok, ByteString const& error) {
        auto& r = state->result;
        r.elapsed_ms = now_ms() - state->started_ms;
        if (!ok) {
            r.error = error;
            state->done(move(r));
            return;
        }
        auto status = r.status;
        if ((status == 301 || status == 302 || status == 303 || status == 307 || status == 308) && r.headers) {
            auto location = r.headers->get("Location"sv);
            if (location.has_value() && state->redirects_left > 0) {
                auto next = URL::Parser::basic_parse(*location, r.url);
                if (next.has_value() && next->scheme().is_one_of("http"sv, "https"sv)) {
                    auto method = (status == 303 || ((status == 301 || status == 302) && state->method == "POST")) ? "GET"sv : StringView(state->method);
                    Optional<NavigationInitiator> next_initiator = initiator;
                    if (next_initiator.has_value())
                        next_initiator->redirected_from.append(r.url.origin());
                    fetch_document_step(*next, method, state->redirects_left - 1, state->started_ms, state->result.redirect_count + 1, move(next_initiator), move(state->done));
                    return;
                }
            }
            if (location.has_value() && state->redirects_left == 0)
                r.error = "too many redirects";
        }
        state->done(move(r));
    };
    submit(move(spec), move(sink));
}

void fetch_document(URL::URL const& url, Function<void(DocumentResult)> done)
{
    Optional<NavigationInitiator> initiator;
    if (s_next_navigation_initiator.has_value() && s_next_navigation_initiator->url == url)
        initiator = s_next_navigation_initiator;
    s_next_navigation_initiator.clear();
    fetch_document_step(url, "GET", 20, now_ms(), 0, move(initiator), move(done));
}

void dump()
{
    static constexpr StringView state_names[] = { "connecting"sv, "handshaking"sv, "ready"sv, "closed"sv };
    for (auto& [id, c] : s_by_stream) {
        if (c->protocol == Connection::Protocol::Http2) {
            log(ByteString::formatted("ganglion: net: stream {} {} h2{}: {} open streams, {} opened", id, c->key, c->draining ? " (draining)" : "", c->streams.size(), c->streams_opened));
            for (auto& [stream_id, r] : c->streams)
                log(ByteString::formatted("ganglion: net:   h2 stream {} for {:.0f} ms: {}{}", stream_id, now_ms() - r->started_ms, r->spec.url.to_byte_string(), r->headers_done ? ByteString::formatted(" (status {})", r->status) : ByteString(" (no headers yet)")));
            continue;
        }
        auto& r = c->current;
        log(ByteString::formatted("ganglion: net: stream {} {} {} {}: {}{}", id, c->key, state_names[static_cast<int>(c->state)],
            r ? ByteString::formatted("busy for {:.0f} ms", now_ms() - r->started_ms) : ByteString("idle"),
            r ? r->spec.url.to_byte_string() : ByteString("-"),
            r && r->headers_done ? ByteString::formatted(" (status {}, framing {}, {} left, {} unparsed)", r->status, static_cast<int>(r->framing), r->remaining, c->rx.size()) : ByteString(" (no headers yet)")));
    }
    for (auto& [key, pool] : s_pools) {
        if (!pool.waiting.is_empty())
            log(ByteString::formatted("ganglion: net: {} waiting for {} ({} connections): first {}", pool.waiting.size(), key, pool.connections.size(), pool.waiting.first()->spec.url.to_byte_string()));
    }
}

void open_tunnel(u32 tunnel_id, RequestSpec spec, TunnelSink sink)
{
    auto state = adopt_ref(*new TunnelState);
    state->id = tunnel_id;
    state->sink = move(sink);
    s_tunnels.set(state->id, state);
    auto request = adopt_ref(*new Request);
    request->spec = move(spec);
    request->tunnel = state;
    // The upgrade failed before a 101 (refused, closed, timed out, a TLS error): the tunnel ends with the request's error.
    request->sink.on_complete = [state](bool, ByteString const& error) {
        tunnel_finish(*state, error.is_empty() ? ByteString("network error") : error);
    };
    auto key = ByteString::formatted("tunnel:{}:{}", state->id, origin_key(request->spec.url));
    request->key = key;
    s_pools.ensure(key).waiting.append(request);
    s_stats.requests++;
    dispatch(key);
}

static Connection* tunnel_connection(u32 id)
{
    for (auto& [stream, c] : s_by_stream)
        if (c->tunnel && c->tunnel->id == id)
            return c;
    return nullptr;
}

bool tunnel_write(u32 id, ReadonlyBytes bytes)
{
    auto* c = tunnel_connection(id);
    if (!c || c->tunnel->closed || c->state != Connection::State::Ready)
        return false;
    send_plain(*c, bytes);
    return true;
}

void tunnel_close(u32 id)
{
    auto it = s_tunnels.find(id);
    if (it == s_tunnels.end())
        return;
    auto tunnel = it->value;
    tunnel->closed = true; // its user closed it: no on_close
    s_tunnels.remove(id);
    if (auto* c = tunnel_connection(id)) {
        close_connection(*c, "closed", true);
        return;
    }
    // Still connecting (the request is on a connection) or waiting.
    for (auto& [stream, c] : s_by_stream) {
        if (c->current && c->current->tunnel == tunnel) {
            c->current = nullptr;
            close_connection(*c, "closed", true);
            return;
        }
    }
    for (auto& [key, pool] : s_pools)
        pool.waiting.remove_all_matching([&](auto const& r) { return r->tunnel == tunnel; });
}

void reset()
{
    s_generation++;
    s_waiting_for_room = false;
    Vector<Connection*> all;
    for (auto& [id, c] : s_by_stream)
        all.append(c);
    for (auto* c : all) {
        auto request = c->current;
        c->current = nullptr;
        auto tunnel = c->tunnel;
        Vector<NonnullRefPtr<Request>> streams;
        for (auto& [stream_id, r] : c->streams)
            streams.append(r);
        c->streams.clear();
        c->h2_events.clear();
        ganglion_host_tcp_close(c->id);
        delete c;
        for (auto& r : streams) {
            if (r->done)
                continue;
            r->done = true;
            s_stats.failures++;
            if (r->sink.on_complete)
                r->sink.on_complete(false, "navigation");
        }
        if (tunnel)
            tunnel_finish(*tunnel, "navigation");
        if (request) {
            s_stats.failures++;
            if (request->sink.on_complete)
                request->sink.on_complete(false, "navigation");
        }
    }
    s_by_stream.clear();
    for (auto& [key, pool] : s_pools) {
        for (auto& request : pool.waiting) {
            s_stats.failures++;
            if (request->sink.on_complete)
                request->sink.on_complete(false, "navigation");
        }
    }
    s_pools.clear();
    if (s_timer) {
        s_timer->stop();
        s_timer = nullptr;
    }
}

}
