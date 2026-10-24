#include "ws.hpp"

#include "simd.hpp"

namespace wisp {

std::size_t ws_header(u8* out, u8 opcode, std::size_t len) {
  out[0] = u8(0x80 | opcode);
  if (len < 126) { out[1] = u8(len); return 2; }
  if (len < 65536) { out[1] = 126; store_be16(out + 2, u16(len)); return 4; }
  out[1] = 127;
  u64 v = len;
  for (int i = 0; i < 8; i++) out[2 + i] = u8(v >> (56 - 8 * i));
  return 10;
}

std::size_t ws_header_before(u8* end, u8 opcode, std::size_t len) {
  std::size_t hl = len < 126 ? 2 : len < 65536 ? 4 : 10;
  ws_header(end - hl, opcode, len);
  return hl;
}

bool ws_close_payload_ok(bytes p) {
  if (p.empty()) return true;
  if (p.size() == 1) return false;
  u16 code = load_be16(p.data());
  bool ok = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999);
  if (!ok) return false;
  return utf8_valid(p.data() + 2, p.size() - 2);
}

bool WsReader::frame(u8 op, bool fin, mbytes payload, WsSink& sink) {
  if (op >= 8) {
    if (!fin || payload.size() > 125) return fail(WS_PROTOCOL);
    if (op != OP_CLOSE && op != OP_PING && op != OP_PONG) return fail(WS_PROTOCOL);
    if (op == OP_CLOSE) {
      if (!ws_close_payload_ok(payload)) return fail(WS_PROTOCOL);
      closed_ = true;
    }
    sink.on_control(op, payload);
    return true;
  }
  if (op != OP_CONT && op != OP_TEXT && op != OP_BINARY) return fail(WS_PROTOCOL);
  if (op != OP_CONT) {
    if (frag_op_ != 0xff) return fail(WS_PROTOCOL);  // new message inside a fragmented one
    if (fin) {                                       // the common case: one frame, zero copies
      if (op == OP_TEXT && !utf8_valid(payload.data(), payload.size())) return fail(WS_BAD_DATA);
      sink.on_message(op, payload);
      return true;
    }
    frag_ = sink.frag_acquire(max_);
    if (frag_.size() < max_) { frag_ = {}; return fail(WS_POLICY); }
    frag_op_ = op;
    frag_len_ = 0;
  } else if (frag_op_ == 0xff) {
    return fail(WS_PROTOCOL);  // continuation without a start
  }
  // payload.size() <= max_ (checked on the header), frag_len_ <= max_: no overflow
  if (payload.size() > max_ - frag_len_) return fail(WS_TOO_BIG);
  std::memcpy(frag_.data() + frag_len_, payload.data(), payload.size());
  frag_len_ += payload.size();
  if (fin) {
    u8 mop = frag_op_;
    mbytes msg = frag_.subspan(0, frag_len_);
    frag_op_ = 0xff;
    bool ok = mop != OP_TEXT || utf8_valid(msg.data(), msg.size());
    if (ok) sink.on_message(mop, msg);
    frag_ = {};
    frag_len_ = 0;
    sink.frag_release();
    if (!ok) return fail(WS_BAD_DATA);
  }
  return true;
}

std::size_t WsReader::parse(u8* buf, std::size_t n, WsSink& sink) {
  std::size_t off = 0;
  while (!error_ && !closed_) {
    std::size_t rem = n - off;
    if (rem < 2) { need_ = 2; break; }
    const u8* p = buf + off;
    bool fin = p[0] & 0x80;
    if (p[0] & 0x70) { fail(WS_PROTOCOL); break; }  // no extensions negotiated
    u8 op = p[0] & 0x0f;
    if (!(p[1] & 0x80)) { fail(WS_PROTOCOL); break; }  // client frames must be masked
    u64 len = p[1] & 0x7f;
    std::size_t at = 2;
    if (len == 126) {
      if (rem < 4) { need_ = 4; break; }
      len = load_be16(p + 2);
      at = 4;
    } else if (len == 127) {
      if (rem < 10) { need_ = 10; break; }
      len = load_be64(p + 2);
      if (len >> 63) { fail(WS_PROTOCOL); break; }  // most significant bit must be 0
      at = 10;
    }
    if (op >= 8 && len > 125) { fail(WS_PROTOCOL); break; }
    if (len > max_) { fail(WS_TOO_BIG); break; }
    // len <= max_ (a size_t), so the sum cannot overflow
    std::size_t total = at + 4 + std::size_t(len);
    if (rem < total) { need_ = total; break; }
    u8 key[4] = {p[at], p[at + 1], p[at + 2], p[at + 3]};
    u8* payload = buf + off + at + 4;
    unmask(payload, std::size_t(len), key, 0);
    off += total;
    need_ = 2;
    if (!frame(op, fin, mbytes(payload, std::size_t(len)), sink)) break;
    if (!sink.want_more()) break;
  }
  return off;
}

void WsReader::reset(WsSink& sink) {
  if (frag_op_ != 0xff || !frag_.empty()) {
    frag_op_ = 0xff;
    frag_ = {};
    frag_len_ = 0;
    sink.frag_release();
  }
}

}  // namespace wisp
