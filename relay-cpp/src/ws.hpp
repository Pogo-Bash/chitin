// RFC 6455 server side: incremental parser for masked client frames (fragment reassembly,
// control frames, UTF-8 checks) and unmasked server frame headers built in place.
#pragma once
#include "common.hpp"

namespace wisp {

enum : u8 { OP_CONT = 0, OP_TEXT = 1, OP_BINARY = 2, OP_CLOSE = 8, OP_PING = 9, OP_PONG = 10 };

// Close status codes (RFC 6455 7.4.1)
enum : u16 { WS_NORMAL = 1000, WS_GOING_AWAY = 1001, WS_PROTOCOL = 1002, WS_BAD_DATA = 1007, WS_POLICY = 1008, WS_TOO_BIG = 1009 };

constexpr std::size_t kMaxServerHeader = 10;  // 2 + 8 byte length

// Writes the header of an unmasked FIN frame carrying `len` payload bytes so that it ENDS at
// `end` (the payload follows it). Returns the header size (2, 4 or 10).
std::size_t ws_header_before(u8* end, u8 opcode, std::size_t len);
// Header at `out` (front). Returns its size.
std::size_t ws_header(u8* out, u8 opcode, std::size_t len);

class WsSink {
 public:
  virtual ~WsSink() = default;
  // A complete data message (opcode BINARY or TEXT). The payload is unmasked and writable and
  // stays valid only during the call.
  virtual void on_message(u8 opcode, mbytes payload) = 0;
  // PING / PONG / CLOSE (payload <= 125 bytes, unmasked).
  virtual void on_control(u8 opcode, mbytes payload) = 0;
  // Storage for reassembling a fragmented message: at least `max` bytes, or empty to refuse
  // (the parser then fails with WS_POLICY). Released with frag_release().
  virtual mbytes frag_acquire(std::size_t max) = 0;
  virtual void frag_release() = 0;
  // Checked after every frame: false stops parse() (it returns what it consumed so far, and the
  // caller resumes later from there), e.g. while the connection is paused or ending.
  virtual bool want_more() { return true; }
};

class WsReader {
 public:
  explicit WsReader(std::size_t max_message) : max_(max_message) {}
  ~WsReader() = default;

  // Parse complete frames in buf[0..n) (the buffer is modified: payloads are unmasked in place).
  // Returns the bytes consumed. On a protocol error returns the bytes consumed so far and sets
  // error() to the close code to send; the connection must then be closed. A frame that is not
  // complete is left unconsumed; needed() then says how many bytes (from buf + consumed) the next
  // call needs to make progress, never more than max_message + 14.
  std::size_t parse(u8* buf, std::size_t n, WsSink& sink);
  u16 error() const { return error_; }
  std::size_t needed() const { return need_; }
  bool closed() const { return closed_; }
  // Drop any reassembly in progress (connection teardown).
  void reset(WsSink& sink);

 private:
  bool fail(u16 code) { error_ = code; return false; }
  bool frame(u8 op, bool fin, mbytes payload, WsSink& sink);
  std::size_t max_;
  u16 error_ = 0;
  std::size_t need_ = 2;
  bool closed_ = false;
  // fragmented message in progress
  u8 frag_op_ = 0xff;
  mbytes frag_{};
  std::size_t frag_len_ = 0;
};

// Validates a CLOSE payload (RFC 6455 5.5.1, 7.4): empty, or a 2-byte valid code + UTF-8 reason.
bool ws_close_payload_ok(bytes p);

}  // namespace wisp
