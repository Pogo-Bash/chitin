#!/bin/sh
# Long fuzzing runs: tools/fuzz-all.sh SECONDS_SESSION SECONDS_EACH  (logs in build/fuzzlogs)
cd "$(dirname "$0")/../build" || exit 1
S=${1:-2700}; E=${2:-900}
mkdir -p fuzzlogs
( nice -n 15 ./fuzz_session -max_total_time=$S ../fuzz/corpus/session ../fuzz/seeds/session > fuzzlogs/session.log 2>&1 ) &
for f in ws http wisp ip dns tls; do
  nice -n 15 ./fuzz_$f -max_total_time=$E ../fuzz/corpus/$f ../fuzz/seeds/$f > fuzzlogs/$f.log 2>&1
done
wait
