#!/usr/bin/env bash
#
# Builds the engine's golden trace (core/tests/golden_trace.cpp) for a kit's
# target, in the build container. Run in the TEST container afterwards (Wine for
# Windows) it must print the hash stream the gate's other targets print --
# packager/scripts/build_kits.sh compares it with this machine's native trace.
#
# The sources and flags are READ OUT OF engine/scripts/check_determinism.sh, so
# the kit is held to exactly the gate's build of the core.
set -euo pipefail
ROOT=/src/engine
eval "$(grep -E '^(FLAGS|SRCS)=\(' "$ROOT/scripts/check_determinism.sh")"
for t in "$@"; do
  case "$t" in
    linux)   mkdir -p /out/linux-x64
             clang++ "${FLAGS[@]}" "${SRCS[@]}" -o /out/linux-x64/golden_trace ;;
    windows) mkdir -p /out/windows-x64
             x86_64-w64-mingw32-g++-posix "${FLAGS[@]}" "${SRCS[@]}" -static -o /out/windows-x64/golden_trace.exe ;;
  esac
  echo "[trace] $t built"
done
