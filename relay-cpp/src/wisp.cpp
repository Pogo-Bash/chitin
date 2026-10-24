#include "wisp.hpp"

#include "simd.hpp"

namespace wisp {

bool parse_packet(mbytes msg, Packet& out) {
  if (msg.size() < kWispHeader) return false;
  out.type = msg[0];
  out.id = load_le32(msg.data() + 1);
  out.payload = msg.subspan(kWispHeader);
  return true;
}

bool parse_connect(bytes p, Connect& out) {
  if (p.size() < 3) return false;
  out.stream_type = p[0];
  out.port = load_le16(p.data() + 1);
  bytes host = p.subspan(3);
  if (!utf8_valid(host.data(), host.size())) return false;
  out.host = as_sv(host);
  return true;
}

const Info::Ext* Info::find(u8 id) const {
  for (unsigned i = 0; i < count; i++)
    if (ext[i].id == id) return &ext[i];
  return nullptr;
}

bool parse_info(bytes p, Info& out) {
  out = Info{};
  if (p.size() < 2) return false;
  out.major = p[0];
  out.minor = p[1];
  std::size_t i = 2;
  while (p.size() - i >= 5) {
    u8 id = p[i];
    u32 n = load_le32(p.data() + i + 1);
    i += 5;
    if (n > p.size() - i) return false;  // overruns (no addition: cannot wrap)
    bytes data = p.subspan(i, n);
    i += n;
    bool replaced = false;
    for (unsigned k = 0; k < out.count; k++)
      if (out.ext[k].id == id) { out.ext[k].data = data; replaced = true; break; }
    if (!replaced && out.count < kMaxExtensions) out.ext[out.count++] = Info::Ext{id, data};
  }
  return true;
}

std::string_view password_of(bytes ext) {
  if (ext.empty()) return {};
  std::size_t skip = 1 + std::size_t(ext[0]);
  if (skip > ext.size()) return {};
  return as_sv(ext.subspan(skip));
}

}  // namespace wisp
