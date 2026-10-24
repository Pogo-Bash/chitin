// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Ganglion's network: TCP streams the host opens through Spiracle, TLS inside the engine (OpenSSL over
// memory BIOs), HTTP/2 (nghttp2, by ALPN) or HTTP/1.1 with keep-alive, content decoding, a connection pool per host. Ladybird's
// Fetch stack reaches it through ResourceLoader's embedder loader (patch 0011); the host's navigation
// reaches it through fetch_document (docs/network.md).

#pragma once

#include <AK/ByteBuffer.h>
#include <AK/ByteString.h>
#include <AK/Function.h>
#include <AK/RefCounted.h>
#include <AK/Vector.h>
#include <LibHTTP/HeaderList.h>
#include <LibURL/URL.h>
#include <LibWeb/Loader/ResourceLoader.h>

namespace Ganglion::Net {

// Where a response goes: headers once, body bytes as they arrive (already decoded), then the end.
struct Sink {
    Function<void(u32 status, ByteString const& reason, NonnullRefPtr<HTTP::HeaderList>)> on_headers;
    Function<void(ReadonlyBytes)> on_data;
    Function<void(bool ok, ByteString const& error)> on_complete;
    // Just before a successful on_complete: when the request's phases happened (Resource Timing).
    Function<void(struct Timing const&)> on_timing;
};

// A request's phases in milliseconds of the engine's clock (now_ms), and the bytes of its body as they came over the
// connection (before content codings were removed). A request on a reused connection has no connect phase (zeros).
struct Timing {
    double submitted_ms { 0 };
    double connect_start_ms { 0 };
    double secure_connect_start_ms { 0 };
    double connect_end_ms { 0 };
    double request_start_ms { 0 };
    double response_start_ms { 0 };
    double response_end_ms { 0 };
    u64 encoded_body_bytes { 0 };
    bool h2 { false }; // carried over HTTP/2 (ALPN "h2")
};

struct Header {
    ByteString name;
    ByteString value;
};

// Cookies (docs/cookies.md). The jar is the host's (glue/cookies.js: RFC 6265bis as Chrome keeps it); the engine asks it for
// the Cookie header of each request it sends and hands it each response's Set-Cookie lines, hop by hop (the network never
// follows a redirect without the jar seeing it). `context` is the request as the jar's SameSite rules need it: its kind
// ("navigate-top", "navigate-frame", "subresource", "websocket") and its method, on two lines.
ByteString cookie_header(URL::URL const&, StringView context);
void store_cookies(URL::URL const&, HTTP::HeaderList const&, StringView context);

// A request on the wire. `headers` are sent as given, after Host; Accept-Encoding, Connection and
// Content-Length are added when absent.
struct RequestSpec {
    ByteString method { "GET" };
    URL::URL url;
    Vector<Header> headers;
    ByteBuffer body;
    // RFC 9218 extensible priority (urgency 0 most urgent .. 7, default 3; incremental: the response is useful in parts).
    // Sent as the Priority field over HTTP/2, and orders each origin's waiting requests for both versions.
    u8 urgency { 3 };
    bool incremental { false };
};

// The urgency and incremental flag for a request, from its Fetch destination ("document", "style", "image", "" ...),
// its priority hint ("high", "low", "auto") and whether it is a navigation (docs/network.md, "HTTP/2").
struct Priority {
    u8 urgency { 3 };
    bool incremental { false };
};
Priority priority_for(StringView destination, StringView fetch_priority, bool navigation);

// Name resolution answers the host learned for `host` (empty: forget them), and the address a TCP stream connected to.
// Both feed HTTP/2 connection pooling (Chrome's rule: a connection serves another host whose name resolves to the
// address it is connected to, when its certificate is valid for that host); without them nothing is pooled.
void set_dns_answer(ByteString const& host, Vector<ByteString> addresses);
void tcp_peer(u32 stream_id, ByteString const& address);

// The trust store for TLS: a PEM bundle of CA certificates (Mozilla's, shipped beside the engine).
// Before the first https request; may be called again to replace it.
void set_ca_bundle(ReadonlyBytes pem);

// The Sec-CH-UA, Sec-CH-UA-Mobile and Sec-CH-UA-Platform values sent on https requests (empty: none are sent).
void set_client_hints(ByteString sec_ch_ua, ByteString mobile, ByteString platform, ByteString sec_ch_ua_hidden);

// Queues a request; the sink's callbacks run from later host events (never from inside this call).
void submit(RequestSpec, Sink);

// A tunnel: an HTTP/1.1 request whose answer is "101 Switching Protocols", after which the connection (TLS included, checked
// against the trust store like any other) carries the upgraded protocol's bytes both ways. A page's WebSocket is the user: the
// handshake request is the host's to build (the key, the Origin, the protocols), the framing is the host's too; the engine only
// owns the TCP and the TLS, so no certificate is judged outside it. The connection is never pooled and never idle-closed.
// `https` and `http` URLs (a `wss` URL is made `https` by the caller). Callbacks run from later host events.
struct TunnelSink {
    // The 101 arrived: its status line and headers. Bytes the server sent right behind it follow through on_data.
    Function<void(u32 status, ByteString const& reason, HTTP::HeaderList const&)> on_open;
    Function<void(ReadonlyBytes)> on_data;
    // The tunnel is over: `error` is empty when the TCP stream ended normally. Also called when the upgrade was refused or never
    // happened (on_open was not called). Not called after tunnel_close.
    Function<void(ByteString const& error)> on_close;
};
// `id` is the caller's (unique among open tunnels), so a callback that runs inside this very call already knows it.
void open_tunnel(u32 id, RequestSpec, TunnelSink);
bool tunnel_write(u32 id, ReadonlyBytes);
void tunnel_close(u32 id);

// The loader ResourceLoader hands http(s) loads to (set in install_network).
void load(Web::LoadRequest const&, GC::Root<Web::ResourceLoader::OnHeadersReceived>, GC::Root<Web::ResourceLoader::OnDataReceived>, GC::Root<Web::ResourceLoader::OnComplete>);

// A document for a navigation: GET with a browser's Accept headers, redirects followed (at most 20,
// 303 and 301/302-after-POST become GET). `done` gets the final URL, status, headers and the body, or
// an error message.
struct DocumentResult {
    URL::URL url;
    u32 status { 0 };
    RefPtr<HTTP::HeaderList> headers;
    ByteBuffer body;
    ByteString error; // non-empty on failure
    double elapsed_ms { 0 };
    // For the navigation timing entry: when the fetch started (now_ms), how many redirects it followed, and the final
    // request's phases (its submitted_ms is the post-redirect start).
    double started_ms { 0 };
    u32 redirect_count { 0 };
    Timing timing;
};
void fetch_document(URL::URL const&, Function<void(DocumentResult)> done);
// The Referer of the document fetches from now on (a nested segment's: its embedder's referrer; empty: none).
void set_document_referrer(ByteString);

// Who asked for the next document fetch of `url` (Fetch Metadata, https://w3c.github.io/webappsec-fetch-metadata/): the
// page's origin and whether it had a user activation. Without one the navigation is the user's own (the address bar):
// Sec-Fetch-Site none, Sec-Fetch-User ?1. Consumed by the next fetch_document of that URL.
void set_next_navigation_initiator(URL::URL const& url, URL::Origin initiator, bool user_activated);

// Events from the host's TCP streams (ganglion_tcp_* exports).
void tcp_opened(u32 stream_id);
void tcp_data(u32 stream_id, ReadonlyBytes);
void tcp_closed(u32 stream_id, u32 reason);

// Counters for the numbers (ganglion_net_stats).
struct Stats {
    u64 bytes_received { 0 };    // TCP bytes in, ciphertext for https
    u64 bytes_sent { 0 };
    u64 connections { 0 };
    u64 tls_handshakes { 0 };
    double tls_handshake_ms { 0 }; // summed wall time from ClientHello sent to handshake done
    double tls_handshake_cpu_ms { 0 }; // summed time inside SSL_do_handshake
    u64 requests { 0 };
    u64 completed { 0 };
    u64 failures { 0 };
    u32 ca_certificates { 0 };
    u64 h2_connections { 0 }; // connections whose server selected "h2"
    u64 h2_streams { 0 };     // requests sent as HTTP/2 streams
    u64 h2_pooled { 0 };      // dispatch rounds that used another host's HTTP/2 connection
};
Stats const& stats();

// Logs every connection's state and current request, and what waits in each pool (for a stuck page).
void dump();

// Closes everything (a new page, or the end).
void reset();

}
