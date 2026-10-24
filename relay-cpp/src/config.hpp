// Command line and environment, compatible with packages/wisp/bin/rvwasm-wisp-server.js plus the
// engine options of this server.
#pragma once
#include <string>

#include "server.hpp"

namespace wisp {

extern const char* const kUsage;

// Parses argv into c. Returns 0 to run, 1 when --help was printed, 2 on an error (message in err).
int parse_config(int argc, char** argv, Config& c, std::string& err, bool& simd);

// Every address of this machine's interfaces (zone ids dropped), for the automatic block.
std::vector<Cidr> interface_addresses();

}  // namespace wisp
