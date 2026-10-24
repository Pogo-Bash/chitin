# wisp-cpp: no dependencies beyond the OS, the C++ standard library and the compiler.
#   make            release server (build/wisp-server) + tools
#   make test       unit tests (+ ASan/UBSan build of them)
#   make fuzz       fuzz targets (ASan+UBSan+coverage, own driver unless FUZZ_ENGINE=libfuzzer)
#   make tsan       ThreadSanitizer stress test (needs a compiler with TSan runtime, e.g. Linux gcc/clang)
# Knobs: CXX, JOBS (use make -j$(JOBS)), IO_URING=1 (Linux), TEST_HOOKS=1 (test-only egress redirect)

CXX ?= c++
UNAME := $(shell uname -s)
ARCH := $(shell uname -m)
BUILD ?= build

WARN := -Wall -Wextra -Werror -Wno-unused-parameter
STD := -std=c++23
HARDEN := -fstack-protector-strong -fPIE -D_FORTIFY_SOURCE=2
LDHARDEN :=
ifeq ($(UNAME),Linux)
  HARDEN += -fstack-clash-protection -D_GLIBCXX_ASSERTIONS
  LDHARDEN += -pie -Wl,-z,relro,-z,now,-z,noexecstack
  LIBS = -pthread $(TLSLIBS)
else
  HARDEN += -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST
  LIBS = $(TLSLIBS)
endif
ifeq ($(ARCH),arm64)
  HARDEN += -mbranch-protection=standard
endif
ifeq ($(ARCH),aarch64)
  HARDEN += -mbranch-protection=standard
endif
ifeq ($(ARCH),x86_64)
  HARDEN += -fcf-protection=full
endif

OPT ?= -O2 -g
DEFS :=
ifeq ($(IO_URING),1)
  DEFS += -DWISP_IO_URING=1
endif
# TLS=1: native wss:// with the system OpenSSL 3 (dynamic libssl/libcrypto; Linux adds kTLS)
ifeq ($(TLS),1)
  DEFS += -DWISP_TLS=1
  TLSLIBS := -lssl -lcrypto
endif
ifeq ($(TEST_HOOKS),1)
  DEFS += -DWISP_TEST_HOOKS=1
endif

CXXFLAGS_ALL = $(STD) $(WARN) $(HARDEN) $(OPT) $(DEFS) $(EXTRA)

CORE := src/hash.cpp src/simd.cpp src/ip.cpp src/policy.cpp src/http.cpp src/ws.cpp src/wisp.cpp src/dnsmsg.cpp
SERVER := $(CORE) src/pool.cpp src/loop.cpp src/dns.cpp src/limits.cpp src/server.cpp src/config.cpp src/log.cpp src/tls.cpp
HDRS := $(wildcard src/*.hpp)

.PHONY: all test fuzz tsan clean bench-tools
all: $(BUILD)/wisp-server $(BUILD)/wisp-bench

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/wisp-server: $(SERVER) src/main.cpp $(HDRS) | $(BUILD)
	$(CXX) $(CXXFLAGS_ALL) $(LDHARDEN) -o $@ $(SERVER) src/main.cpp $(LIBS)

$(BUILD)/wisp-server-test: $(SERVER) src/main.cpp $(HDRS) | $(BUILD)
	$(CXX) $(STD) $(WARN) $(filter-out -D_FORTIFY_SOURCE=2,$(HARDEN)) -O1 -g -DWISP_TEST_HOOKS=1 $(DEFS) -fsanitize=address,undefined -fno-omit-frame-pointer \
	  -o $@ $(SERVER) src/main.cpp $(LIBS)

$(BUILD)/wisp-bench: bench/wisp-bench.cpp $(CORE) $(HDRS) | $(BUILD)
	$(CXX) $(CXXFLAGS_ALL) $(LDHARDEN) -o $@ bench/wisp-bench.cpp $(CORE) $(LIBS)

$(BUILD)/test-units: tests/test_units.cpp $(CORE) $(HDRS) | $(BUILD)
	$(CXX) $(CXXFLAGS_ALL) -o $@ tests/test_units.cpp $(CORE) $(LIBS)

$(BUILD)/test-units-asan: tests/test_units.cpp $(CORE) $(HDRS) | $(BUILD)
	$(CXX) $(STD) $(WARN) -O1 -g -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer -o $@ tests/test_units.cpp $(CORE) $(LIBS)

$(BUILD)/test-pool: tests/test_pool.cpp src/pool.cpp src/limits.cpp $(HDRS) | $(BUILD)
	$(CXX) $(CXXFLAGS_ALL) -o $@ tests/test_pool.cpp src/pool.cpp src/limits.cpp src/hash.cpp src/ip.cpp $(LIBS) -pthread

$(BUILD)/test-tls-gather: tests/audit_tls_gather.cpp src/tls.hpp src/common.hpp | $(BUILD)
	$(CXX) $(STD) $(WARN) -O1 -g -fsanitize=address,undefined -fno-sanitize-recover=all -o $@ tests/audit_tls_gather.cpp

test: $(BUILD)/test-units $(BUILD)/test-units-asan $(BUILD)/test-pool $(BUILD)/test-tls-gather
	$(BUILD)/test-tls-gather
	$(BUILD)/test-units
	$(BUILD)/test-units-asan
	$(BUILD)/test-pool

# ---- fuzzing ---------------------------------------------------------------------------------
FUZZ_ENGINE ?= own
FUZZ_SAN := -O1 -g -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer
ifeq ($(FUZZ_ENGINE),libfuzzer)
  FUZZ_FLAGS := $(FUZZ_SAN) -fsanitize=fuzzer
else
  FUZZ_FLAGS := $(FUZZ_SAN) -fsanitize-coverage=trace-pc-guard
endif
FUZZERS := fuzz_http fuzz_ws fuzz_wisp fuzz_ip fuzz_dns fuzz_session fuzz_tls
fuzz: $(addprefix $(BUILD)/,$(FUZZERS))

ifeq ($(FUZZ_ENGINE),libfuzzer)
FUZZ_DRIVER_OBJ :=
else
FUZZ_DRIVER_OBJ := $(BUILD)/fuzz_driver.o
$(BUILD)/fuzz_driver.o: fuzz/driver.cpp | $(BUILD)
	$(CXX) $(STD) $(WARN) $(FUZZ_SAN) -c -o $@ $<
endif

SESSION_SRC := $(filter-out src/config.cpp,$(SERVER))
$(BUILD)/fuzz_session: fuzz/fuzz_session.cpp $(FUZZ_DRIVER_OBJ) $(SESSION_SRC) src/fuzz_session.inc $(HDRS) | $(BUILD)
	$(CXX) $(STD) $(WARN) $(FUZZ_FLAGS) -DWISP_FUZZ=1 -o $@ fuzz/fuzz_session.cpp $(SESSION_SRC) $(FUZZ_DRIVER_OBJ) $(LIBS) -pthread

$(BUILD)/fuzz_%: fuzz/fuzz_%.cpp $(FUZZ_DRIVER_OBJ) $(CORE) $(HDRS) | $(BUILD)
	$(CXX) $(STD) $(WARN) $(FUZZ_FLAGS) -DWISP_FUZZ=1 -o $@ $< $(CORE) $(FUZZ_DRIVER_OBJ) $(LIBS)

# ---- ThreadSanitizer -------------------------------------------------------------------------
$(BUILD)/test-tsan: tests/test_pool.cpp src/pool.cpp src/limits.cpp $(HDRS) | $(BUILD)
	$(CXX) $(STD) $(WARN) -O1 -g -fsanitize=thread -o $@ tests/test_pool.cpp src/pool.cpp src/limits.cpp src/hash.cpp src/ip.cpp -pthread

$(BUILD)/wisp-server-tsan: $(SERVER) src/main.cpp $(HDRS) | $(BUILD)
	$(CXX) $(STD) $(WARN) -O1 -g -DWISP_TEST_HOOKS=1 $(DEFS) -fsanitize=thread -o $@ $(SERVER) src/main.cpp $(LIBS) -pthread

tsan: $(BUILD)/test-tsan $(BUILD)/wisp-server-tsan
	$(BUILD)/test-tsan

clean:
	rm -rf $(BUILD)

# x86-64 builds on Apple silicon (run under Rosetta 2, which executes AVX2 but hides it from cpuid:
# set WISP_FORCE_SIMD=avx2 to exercise that path)
$(BUILD)/test-units-x86: tests/test_units.cpp $(CORE) $(HDRS) | $(BUILD)
	$(CXX) -arch x86_64 $(STD) $(WARN) -O1 -g -fsanitize=address,undefined -o $@ tests/test_units.cpp $(CORE)
$(BUILD)/wisp-server-test-x86: $(SERVER) src/main.cpp $(HDRS) | $(BUILD)
	$(CXX) -arch x86_64 $(STD) $(WARN) -O1 -g -DWISP_TEST_HOOKS=1 -fsanitize=address,undefined -o $@ $(SERVER) src/main.cpp

# release build with the test egress hook (benchmarks of the production rules: real resolver and
# block-list checks on a public-looking answer, connect redirected to the local echo)
$(BUILD)/wisp-server-hooks: $(SERVER) src/main.cpp $(HDRS) | $(BUILD)
	$(CXX) $(CXXFLAGS_ALL) -DWISP_TEST_HOOKS=1 $(LDHARDEN) -o $@ $(SERVER) src/main.cpp $(LIBS)
