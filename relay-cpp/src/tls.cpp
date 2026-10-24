#include "tls.hpp"

#if WISP_TLS
#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>

#include <atomic>
#include <mutex>
#include <cerrno>
#include <cstring>

namespace wisp {

class TlsContext {
 public:
  struct Entry { SSL_CTX* ctx; X509* cert; };
  std::vector<Entry> entries;
  TlsContext();
  ~TlsContext();
};

namespace {
std::mutex g_mu;  // guards g_current (taken once per new TLS connection and per reload)
std::shared_ptr<TlsContext> g_current;
std::atomic<long> g_live{0};

const unsigned char kAlpn[] = {8, 'h', 't', 't', 'p', '/', '1', '.', '1'};

int alpn_select(SSL*, const unsigned char** out, unsigned char* outlen, const unsigned char* in, unsigned inlen, void*) {
  unsigned char* o = nullptr;
  if (SSL_select_next_proto(&o, outlen, kAlpn, sizeof kAlpn, in, inlen) == OPENSSL_NPN_NEGOTIATED) {
    *out = o;
    return SSL_TLSEXT_ERR_OK;
  }
  return SSL_TLSEXT_ERR_NOACK;  // no overlap: carry on without ALPN
}

int sni_select(SSL* ssl, int*, void* arg) {
  auto* set = static_cast<TlsContext*>(arg);
  const char* name = SSL_get_servername(ssl, TLSEXT_NAMETYPE_host_name);
  if (!name || set->entries.size() < 2) return SSL_TLSEXT_ERR_OK;
  for (auto& e : set->entries) {
    if (X509_check_host(e.cert, name, std::strlen(name), 0, nullptr) == 1) {
      SSL_set_SSL_CTX(ssl, e.ctx);
      break;
    }
  }
  return SSL_TLSEXT_ERR_OK;  // no match: the first certificate
}

std::string ssl_errors() {
  std::string s;
  unsigned long e;
  char buf[256];
  while ((e = ERR_get_error())) {
    ERR_error_string_n(e, buf, sizeof buf);
    if (!s.empty()) s += "; ";
    s += buf;
  }
  return s;
}
}  // namespace

TlsContext::TlsContext() { g_live.fetch_add(1); }
TlsContext::~TlsContext() {
  for (auto& e : entries) SSL_CTX_free(e.ctx);  // frees the keys once no SSL refers to the ctx
  g_live.fetch_sub(1);
}

TlsContext* tls_load(const std::vector<TlsFiles>& files, std::string& err) {
  auto* set = new TlsContext();
  for (const auto& f : files) {
    SSL_CTX* ctx = SSL_CTX_new(TLS_server_method());
    if (!ctx) { err = "SSL_CTX_new: " + ssl_errors(); delete set; return nullptr; }
    SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);
    SSL_CTX_set_options(ctx, SSL_OP_NO_RENEGOTIATION | SSL_OP_CIPHER_SERVER_PREFERENCE | SSL_OP_NO_COMPRESSION | SSL_OP_NO_TICKET
#ifdef SSL_OP_ENABLE_KTLS
                                 | SSL_OP_ENABLE_KTLS
#endif
    );
    SSL_CTX_set_num_tickets(ctx, 0);
    SSL_CTX_set_session_cache_mode(ctx, SSL_SESS_CACHE_OFF);
    SSL_CTX_set_mode(ctx, SSL_MODE_ENABLE_PARTIAL_WRITE | SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER | SSL_MODE_RELEASE_BUFFERS);
    if (!SSL_CTX_set_cipher_list(ctx, "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:"
                                      "ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305") ||
        !SSL_CTX_set_ciphersuites(ctx, "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256")) {
      err = "cipher configuration: " + ssl_errors();
      SSL_CTX_free(ctx);
      delete set;
      return nullptr;
    }
    if (SSL_CTX_use_certificate_chain_file(ctx, f.cert.c_str()) != 1 || SSL_CTX_use_PrivateKey_file(ctx, f.key.c_str(), SSL_FILETYPE_PEM) != 1 ||
        SSL_CTX_check_private_key(ctx) != 1) {
      err = "certificate " + f.cert + " / key " + f.key + ": " + ssl_errors();
      SSL_CTX_free(ctx);
      delete set;
      return nullptr;
    }
    SSL_CTX_set_alpn_select_cb(ctx, alpn_select, nullptr);
    set->entries.push_back({ctx, SSL_CTX_get0_certificate(ctx)});
  }
  if (set->entries.empty()) { err = "no certificate"; delete set; return nullptr; }
  for (auto& e : set->entries) {
    SSL_CTX_set_tlsext_servername_callback(e.ctx, sni_select);
    SSL_CTX_set_tlsext_servername_arg(e.ctx, set);
  }
  return set;
}

void tls_publish(TlsContext* c) {
  std::shared_ptr<TlsContext> old;
  {
    std::lock_guard<std::mutex> g(g_mu);
    old = std::move(g_current);
    g_current.reset(c);
  }
  // `old` is released here: freed now if no connection holds it, else by the last one that does
}
std::shared_ptr<TlsContext> tls_current() {
  std::lock_guard<std::mutex> g(g_mu);
  return g_current;
}
long tls_live_sets() { return g_live.load(); }

bool TlsConn::open(int fd) {
  set = tls_current();
  if (!set) return false;
  ssl = SSL_new(set->entries.front().ctx);
  if (!ssl) return false;
  SSL_set_fd(ssl, fd);
  SSL_set_accept_state(ssl);
  return true;
}

TlsStep TlsConn::handshake() {
  int r = SSL_do_handshake(ssl);
  if (r == 1) {
    done = true;
#ifdef SSL_OP_ENABLE_KTLS
    ktls_tx = BIO_get_ktls_send(SSL_get_wbio(ssl));
    ktls_rx = BIO_get_ktls_recv(SSL_get_rbio(ssl));
#endif
    return TlsStep::Done;
  }
  int e = SSL_get_error(ssl, r);
  ERR_clear_error();
  if (e == SSL_ERROR_WANT_READ) return TlsStep::WantRead;
  if (e == SSL_ERROR_WANT_WRITE) return TlsStep::WantWrite;
  return TlsStep::Fail;
}

ssize_t TlsConn::read(u8* buf, std::size_t n) {
  std::size_t got = 0;
  if (SSL_read_ex(ssl, buf, n, &got) == 1) return ssize_t(got);
  int e = SSL_get_error(ssl, 0);
  ERR_clear_error();
  if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) { errno = EAGAIN; return -1; }
  if (e == SSL_ERROR_ZERO_RETURN) return 0;
  errno = EIO;
  return -1;
}

ssize_t TlsConn::writev(const iovec* v, int cnt) {
  // Small iovecs are gathered into one record-sized piece (one record per SSL_write) so a burst
  // of small frames does not become a burst of tiny records. A write that returned WANT_* is
  // retried with exactly the same bytes and length (tls_next_piece; ACCEPT_MOVING_WRITE_BUFFER
  // lets the copy live in a fresh stage buffer).
  u8 stage[16384];
  ssize_t total = 0;
  int i = 0;
  for (;;) {
    std::size_t len;
    const u8* p = tls_next_piece(v, cnt, i, stage, sizeof stage, pending, len);
    if (!len) {
      if (pending) { errno = EIO; return total ? total : -1; }  // unreachable: the queue lost bytes
      break;
    }
    std::size_t wrote = 0;
    if (SSL_write_ex(ssl, p, len, &wrote) != 1) {
      int e = SSL_get_error(ssl, 0);
      ERR_clear_error();
      if (e == SSL_ERROR_WANT_WRITE || e == SSL_ERROR_WANT_READ) {
        pending = len;  // OpenSSL holds this write: the next call must repeat it exactly
        if (total) return total;
        errno = EAGAIN;
        return -1;
      }
      errno = EIO;
      return total ? total : -1;
    }
    pending = 0;
    total += ssize_t(wrote);
    if (wrote < len) return total;  // partial write (ENABLE_PARTIAL_WRITE): the rest next time
  }
  return total;
}

void TlsConn::shutdown() {
  if (ssl && done) {
    SSL_shutdown(ssl);
    ERR_clear_error();
  }
}

void TlsConn::free() {
  if (ssl) SSL_free(ssl);
  ssl = nullptr;
  set.reset();
}

const char* TlsConn::version() const { return ssl ? SSL_get_version(ssl) : "-"; }

}  // namespace wisp
#endif
