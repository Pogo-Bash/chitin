# Chitin. The public release ships a built engine in build/; `make engine-glue` rebuilds the glue bundle, and
# `make engine` (after tools/ganglion-build.sh, see docs/toolchain.md) copies a freshly built engine in.
# Builds use at most 10 jobs (make -j10 at most; the engine is four files).

BUILD := build
GEN := $(BUILD)/gen
EM := tools/em.sh
PY ?= python3

ENGINE_SRC := toy/engine/Heap.cpp toy/engine/Node.cpp toy/engine/Style.cpp toy/engine/Runtime.cpp toy/engine/Custom.cpp
ENGINE_HDR := toy/engine/Ganglion.h toy/engine/Bindings.h
IDL := $(wildcard toy/idl/*.idl)
GLUE := glue/00-primordials.js glue/10-runtime.js $(GEN)/bindings.gen.js $(wildcard glue/custom/*.js) glue/90-boot.js

CXXFLAGS := -std=c++23 -O2 -fno-exceptions -fno-rtti -Wall -Wextra -Werror -Wno-unused-parameter \
	-Itoy/engine -I$(GEN)
LDFLAGS := --profiling-funcs -sSTANDALONE_WASM --no-entry -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16MB \
	-sEXPORTED_FUNCTIONS=_malloc,_free -sERROR_ON_UNDEFINED_SYMBOLS=0 -sWARN_ON_UNDEFINED_SYMBOLS=0

WEBCOMPAT := $(sort $(wildcard webcompat/*.json))
ENGINE_GLUE := glue/00-primordials.js $(GEN)/webcompat.gen.js $(GEN)/psl.gen.js glue/cookies.js glue/engine/20-wasi.js glue/engine/30-host.js glue/engine/40-bridge.js glue/engine/45-surface.js glue/engine/46-constructible.js glue/engine/50-frames.js glue/engine/52-popups.js glue/engine/55-media.js glue/engine/55-realms.js glue/engine/57-importmap.js glue/engine/58-webgl.js glue/engine/90-boot.js
GANGLION_BUILD ?= $(HOME)/dev/chitin-ext/build/ganglion

all: $(BUILD)/ganglion-toy.wasm $(BUILD)/ganglion.js $(BUILD)/ganglion-engine.js $(BUILD)/cookies.mjs

# The engine glue (the wasm itself is built by tools/ganglion-build.sh; `make engine` copies it here).
$(BUILD)/ganglion-engine.js: $(ENGINE_GLUE) tools/bundle-glue.py
	$(PY) tools/bundle-glue.py --global __chitinEngineBoot $@ $(ENGINE_GLUE)

# The Public Suffix List (third_party/psl, MPL-2.0) as one glue constant, and the cookie code (glue/cookies.js) as a module for
# the carapace's store and the Node tests (docs/cookies.md).
$(GEN)/psl.gen.js: third_party/psl/public_suffix_list.dat tools/psl-gen.py
	$(PY) tools/psl-gen.py $@ $<

$(BUILD)/cookies.mjs: $(GEN)/psl.gen.js glue/cookies.js
	{ cat $(GEN)/psl.gen.js glue/cookies.js; echo 'export default ChitinCookies;'; } > $@

# The site-compatibility list (docs/surface.md): webcompat/*.json as one glue constant.
$(GEN)/webcompat.gen.js: $(WEBCOMPAT) tools/webcompat-gen.py
	$(PY) tools/webcompat-gen.py $@ $(WEBCOMPAT)

# build/ganglion.wasm is a file target: it is copied only when the linked module is newer, so `make engine` (which every test
# target depends on) never overwrites a stamped module made by `make engine-stamp` from the same link with the unstamped one.
engine: $(BUILD)/ganglion-engine.js $(BUILD)/ganglion.wasm $(BUILD)/cookies.mjs

$(BUILD)/ganglion.wasm: $(GANGLION_BUILD)/bin/ganglion.wasm
	cp $< $@

# Eager validation of a module under V8 (tools/wasm-validate.mjs): what Chrome would refuse fails here.
WASM_VALIDATE := node --no-wasm-lazy-validation tools/wasm-validate.mjs


engine-glue: $(BUILD)/ganglion-engine.js $(BUILD)/cookies.mjs

# Run it (see README.md).
serve:
	node harness/server.mjs

relay:
	python3 relay/relay.py --log 1 --allow-any-host

.PHONY: all engine engine-glue serve relay
