// Wisp packets: header, CONNECT, INFO (extension list), password extension.
#include <cstdlib>
#include <vector>

#include "../src/simd.hpp"
#include "../src/wisp.hpp"

using namespace wisp;

extern "C" int LLVMFuzzerTestOneInput(const u8* data, std::size_t n) {
  std::vector<u8> buf(data, data + n);
  Packet p;
  if (!parse_packet(mbytes(buf), p)) {
    if (n >= 5) std::abort();
    return 0;
  }
  if (p.payload.size() != n - 5) std::abort();
  Connect c;
  if (parse_connect(p.payload, c)) {
    if (c.host.size() != p.payload.size() - 3) std::abort();
    if (!utf8_valid_scalar(reinterpret_cast<const u8*>(c.host.data()), c.host.size())) std::abort();
  } else if (p.payload.size() >= 3 && utf8_valid_scalar(p.payload.data() + 3, p.payload.size() - 3)) {
    std::abort();
  }
  Info info;
  if (parse_info(p.payload, info)) {
    if (info.count > kMaxExtensions) std::abort();
    for (unsigned i = 0; i < info.count; i++) {
      const auto& e = info.ext[i];
      if (e.data.data() < p.payload.data() || e.data.data() + e.data.size() > p.payload.data() + p.payload.size()) std::abort();
      for (unsigned k = i + 1; k < info.count; k++) if (info.ext[k].id == e.id) std::abort();  // ids are unique
      auto pw = password_of(e.data);
      if (pw.size() > e.data.size()) std::abort();
    }
  }
  return 0;
}
