#include <sys/resource.h>

#include <csignal>
#include <cstdio>
#include <algorithm>
#include <cstdlib>

#include "config.hpp"
#include "log.hpp"
#include "simd.hpp"
#include "tls.hpp"

#include <pthread.h>
#include <thread>

using namespace wisp;

int main(int argc, char** argv) {
  std::signal(SIGPIPE, SIG_IGN);
  {  // every connection and stream is a descriptor: use the hard limit (bounded) rather than 256/1024
    rlimit r{};
    if (getrlimit(RLIMIT_NOFILE, &r) == 0) {
      rlim_t want = r.rlim_max == RLIM_INFINITY ? 65536 : std::min<rlim_t>(r.rlim_max, 65536);
#ifdef __APPLE__
      want = std::min<rlim_t>(want, 10240);  // OPEN_MAX
#endif
      if (want > r.rlim_cur) { r.rlim_cur = want; setrlimit(RLIMIT_NOFILE, &r); }
    }
  }
  Config c;
  std::string err;
  bool simd = true;
  int r = parse_config(argc, argv, c, err, simd);
  if (r == 1) { std::fputs(kUsage, stdout); return 0; }
  if (r == 2) { std::fprintf(stderr, "wisp-server: %s\n", err.c_str()); return 2; }
  set_simd(simd);
  if (const char* f = std::getenv("WISP_FORCE_SIMD")) force_simd(f);  // tests: e.g. avx2 under Rosetta 2
#if WISP_TLS
  if (!c.tls.empty()) {
    TlsContext* t = tls_load(c.tls, err);
    if (!t) { std::fprintf(stderr, "wisp-server: TLS: %s\n", err.c_str()); return 2; }
    tls_publish(t);
  }
  // SIGHUP: reload the certificates (handled by one thread with sigwait, blocked everywhere else)
  sigset_t hup;
  sigemptyset(&hup);
  sigaddset(&hup, SIGHUP);
  if (!c.tls.empty()) pthread_sigmask(SIG_BLOCK, &hup, nullptr);
#endif
  // Nothing to reload without TLS: SIGHUP (a habitual `kill -HUP`) is a no-op, not a kill (AUDIT A-7)
  if (c.tls.empty()) std::signal(SIGHUP, SIG_IGN);
  Server server(c);
  if (!server.start()) return 1;
#if WISP_TLS
  if (!c.tls.empty()) {
    std::thread([files = c.tls, hup] {
      for (;;) {
        int sig = 0;
        if (sigwait(&hup, &sig) != 0) continue;
        std::string e;
        TlsContext* t = tls_load(files, e);
        if (t) {  // the old set is freed once the connections opened from it are gone
          tls_publish(t);
          log_line(1, "TLS certificates reloaded (%ld set(s) still in use)", tls_live_sets());
        }
        else log_line(1, "TLS reload failed, keeping the old certificates: %s", e.c_str());
      }
    }).detach();
  }
#endif
  std::string origins;
  for (std::size_t i = 0; i < c.origins.size(); i++) origins += (i ? ", " : "") + c.origins[i];
  std::printf("Wisp relay on %s://%s:%u/ for %s\n", c.tls.empty() ? "ws" : "wss", c.bind.c_str(), server.port(), origins.c_str());
  std::printf("  ports ");
  for (std::size_t i = 0; i < c.policy.port_allow.size(); i++) std::printf("%s%u", i ? "," : "", c.policy.port_allow[i]);
  std::printf("; %s; token %s\n", c.policy.allow_private ? "PRIVATE AND LOOPBACK DESTINATIONS ALLOWED (development only)" : "private ranges refused",
              c.token ? "required" : "NONE: the Origin check is not access control, any non-browser client can connect; use --token-file");
  std::printf("  extra blocked ranges: ");
  if (c.policy.block.empty()) std::printf("none");
  for (std::size_t i = 0; i < c.policy.block.size(); i++) std::printf("%s%s", i ? ", " : "", c.policy.block[i].text().c_str());
  std::printf(" (plus the built-in private/special-purpose list)\n");
  bool any = false;
  for (auto& h : c.policy.host_allow) any |= h == "*";
  std::printf("  destinations: ");
  if (any) std::printf("ANY HOST (open proxy to the internet)");
  else for (std::size_t i = 0; i < c.policy.host_allow.size(); i++) std::printf("%s%s", i ? ", " : "", c.policy.host_allow[i].c_str());
  std::printf("\n  engine: %u thread(s), %s unmasking, %s, %s\n", c.threads, simd_name(), c.writev ? "writev batching" : "one write per frame",
              c.tls.empty() ? "plain ws:// (TLS in a proxy)" : "native wss:// (OpenSSL handshake, kTLS when available)");
  std::printf("  You are the operator and responsible for the traffic that leaves this machine.\n");
  std::fflush(stdout);
  server.wait();
  return 0;
}
