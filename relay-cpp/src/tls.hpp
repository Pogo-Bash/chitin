// Native wss:// (optional, WISP_TLS=1): the TLS handshake by the system OpenSSL 3 (libssl, linked
// dynamically; approved dependency, see DESIGN.md), record encryption by the kernel (kTLS, Linux)
// when OpenSSL and the kernel can offload it, else by OpenSSL in user space.
//
//  - TLS 1.3 and 1.2 only; AEAD suites the kernel can offload (AES-128/256-GCM, ChaCha20-Poly1305);
//    no renegotiation, no compression, no session tickets or cache (no per-server session state).
//  - ALPN: "http/1.1" when the client offers it (WebSocket over HTTP/1.1); otherwise no ALPN.
//  - SNI: the certificate whose names match the requested host (X509_check_host), else the first.
//  - Certificates are reloaded on SIGHUP: new connections use the new set, open ones keep theirs.
//
// The connection code sees three calls: handshake step, read, write. With kTLS on the transmit side
// writes go to the socket with writev (the kernel encrypts), so the batching path is unchanged.
#pragma once
#include <sys/uio.h>

#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "common.hpp"

#if WISP_TLS
typedef struct ssl_st SSL;
#endif

namespace wisp {

struct TlsFiles {
  std::string cert, key;  // PEM chain, PEM key
};

// One TLS record's worth of the queue: iovecs from v[i] on. An iovec of at least `cap` bytes is
// returned in place (OpenSSL splits it into records); smaller ones are copied together into
// `stage` while they fit. Empty iovecs are skipped. Advances i past what was taken; len = 0 only
// when nothing is left. (Pure: fuzzed by fuzz_tls without OpenSSL.)
inline const u8* tls_gather(const iovec* v, int cnt, int& i, u8* stage, std::size_t cap, std::size_t& len) {
  while (i < cnt && !v[i].iov_len) i++;
  len = 0;
  if (i >= cnt) return nullptr;
  if (v[i].iov_len >= cap) {
    len = v[i].iov_len;
    return static_cast<const u8*>(v[i++].iov_base);
  }
  // INVARIANT: v[i].iov_len < cap, so at least one iovec is gathered and len <= cap
  while (i < cnt && v[i].iov_len <= cap - len) {
    if (v[i].iov_len) std::memcpy(stage + len, v[i].iov_base, v[i].iov_len);
    len += v[i].iov_len;
    i++;
  }
  return stage;
}

// The piece for the next SSL_write. With nothing pending this is tls_gather. After WANT_WRITE /
// WANT_READ, OpenSSL needs the retry to pass the same bytes with the same length (AUDIT A-5:
// re-gathering could return fewer bytes once the queue's tail block had grown, and OpenSSL then
// fails with SSL_R_BAD_LENGTH). The queue's first `pending` bytes cannot change before they are
// consumed (it only grows at the tail), so the retry takes exactly those: in place when the first
// iovec holds them all, else copied into `stage` again (pending <= cap: it was gathered there).
// Returns nullptr with len 0 only when nothing is queued (or, defensively, when fewer than
// `pending` bytes are queued, which the queue's invariant rules out).
inline const u8* tls_next_piece(const iovec* v, int cnt, int& i, u8* stage, std::size_t cap, std::size_t pending, std::size_t& len) {
  if (!pending) return tls_gather(v, cnt, i, stage, cap, len);
  len = 0;
  while (i < cnt && !v[i].iov_len) i++;
  if (i >= cnt) return nullptr;
  if (v[i].iov_len >= pending) {
    len = pending;
    return static_cast<const u8*>(v[i++].iov_base);
  }
  if (pending > cap) return nullptr;
  std::size_t got = 0;
  while (i < cnt && got < pending) {
    std::size_t k = v[i].iov_len < pending - got ? v[i].iov_len : pending - got;
    if (k) std::memcpy(stage + got, v[i].iov_base, k);
    got += k;
    i++;
  }
  if (got < pending) return nullptr;
  len = pending;
  return stage;
}

#if WISP_TLS
class TlsContext;

// Load every pair; on error returns nullptr with a message. Thread-safe to call while serving.
TlsContext* tls_load(const std::vector<TlsFiles>& files, std::string& err);
// The set new connections use. Sets are reference counted (AUDIT A-7): each connection holds the
// set it was opened from until it ends (its SNI callback reads it during the handshake), so after a
// reload the old certificates and private keys are freed as soon as the last connection using them
// is gone, not kept for the life of the process.
void tls_publish(TlsContext* c);  // takes ownership
std::shared_ptr<TlsContext> tls_current();
long tls_live_sets();  // sets not yet freed (tests/logging)

enum class TlsStep { Done, WantRead, WantWrite, Fail };

struct TlsConn {
  SSL* ssl = nullptr;
  std::shared_ptr<TlsContext> set;  // keeps this connection's certificate set alive
  bool ktls_tx = false, ktls_rx = false;
  bool done = false;
  std::size_t pending = 0;  // length of the SSL_write that must be retried (0: none)
  bool open(int fd);  // from tls_current()
  TlsStep handshake();
  // read: > 0 bytes, 0 = close_notify/EOF, -1 with errno EAGAIN (wait for readability) or another errno.
  ssize_t read(u8* buf, std::size_t n);
  // write the iovecs as TLS records (user space). Returns bytes taken, or -1 with errno EAGAIN/other.
  ssize_t writev(const iovec* v, int cnt);
  void shutdown();  // best-effort close_notify (non-blocking)
  void free();
  const char* version() const;
};
#endif

}  // namespace wisp
