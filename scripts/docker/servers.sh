#!/usr/bin/env bash
#
# Runs INSIDE the container (packager/scripts/build_kits.sh starts it).
#   /src  the repository, read-only
#   /out  where the servers go: /out/linux-x64/dnp-server, /out/windows-x64/dnp-server.exe
#
# Both through the engine's own scripts/build_server.sh -- one source list --
# with a LuaJIT built here for each target from the checkout's pinned source.
set -euo pipefail
WHICH=("$@")
JOBS="$(nproc)"

luajit_copy() {
  rm -rf "/work/$1"; mkdir -p "/work/$1"
  # The source only: the host's build products (a macOS libluajit.a) must not
  # leak into a Linux or Windows link.
  (cd /src/engine/third_party/luajit && tar --exclude='*.o' --exclude='*.a' --exclude='*.so' \
     --exclude='src/luajit' --exclude='src/host/minilua' --exclude='src/host/buildvm' -cf - .) | tar -xf - -C "/work/$1"
}

for t in "${WHICH[@]}"; do
  case "$t" in
    linux)
      luajit_copy luajit-linux
      echo "[servers] linux    luajit"
      make -C /work/luajit-linux -j"$JOBS" amalg BUILDMODE=static CC=clang >/dev/null
      echo "[servers] linux    server"
      DNP_LUAJIT_DIR=/work/luajit-linux DNP_SERVER_OUT=/out/linux-x64 \
      DNP_SERVER_LDFLAGS="-static-libstdc++ -static-libgcc" \
        /src/engine/scripts/build_server.sh
      strip /out/linux-x64/dnp-server
      ;;
    windows)
      luajit_copy luajit-win
      echo "[servers] windows  luajit (mingw-w64)"
      make -C /work/luajit-win -j"$JOBS" amalg HOST_CC=clang CROSS=x86_64-w64-mingw32- \
           TARGET_SYS=Windows BUILDMODE=static >/dev/null
      echo "[servers] windows  server (mingw-w64)"
      DNP_LUAJIT_DIR=/work/luajit-win DNP_SERVER_OUT=/out/windows-x64 \
      DNP_SERVER_CXX=x86_64-w64-mingw32-g++-posix DNP_SERVER_SYSLIBS="-lws2_32" \
      DNP_SERVER_LDFLAGS="-static" DNP_SERVER_EXE=dnp-server.exe \
        /src/engine/scripts/build_server.sh
      x86_64-w64-mingw32-strip /out/windows-x64/dnp-server.exe
      ;;
    *) echo "[servers] unknown target $t" >&2; exit 2 ;;
  esac
done
