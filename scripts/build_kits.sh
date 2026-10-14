#!/usr/bin/env bash
#
# Builds the ENGINE KITS the packager assembles games from.
#
#   packager/scripts/build_kits.sh                 # android linux windows
#   packager/scripts/build_kits.sh android
#   packager/scripts/build_kits.sh linux windows
#
# WHY KITS. Nothing compiled into a game depends on its module: the server reads
# the module's files at run time, the shells read start.txt / game.json, the
# client is the browser's. So the binaries are built ONCE per engine version,
# here, by the engine's own scripts, and the packager -- a page in a browser, on
# any machine, with no SDK -- only lays a module's files beside them, writes the
# fields that name the game, and signs or packs. A kit is a zip plus kit.json.
#
# NOT A SECOND BUILD. Each kit is cut out of what the engine's own script
# produces, so the staging rules live in exactly one place: build_apk.sh for
# Android, build_app.sh for the desktop. Both are run on a throwaway module
# holding one tiny map and nothing else; everything that module put in the
# output is removed, and the kit is refused if its name appears anywhere in
# what remains.
#
# THE DESKTOP SERVERS are built in containers (packager/scripts/docker/):
# Linux x86-64 with clang on Ubuntu 22.04, Windows x86-64 with MinGW-w64 --
# through engine/scripts/build_server.sh and its one source list. Each target's
# golden trace (the determinism gate's program, built the gate's way) must emit
# the same hash stream as this machine's native build, or the kit is refused:
# a server that disagrees with the client's prediction is a game that rubber-
# bands, and nothing about it says why.
#
# Needs: the Android SDK + NDK (android); Docker and network for the first
# Electron download (linux, windows).
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ENGINE="$REPO/engine"
OUT="$HERE/build/kits"
CACHE="$HERE/build/cache"
SERVERS="$HERE/build/servers"
mkdir -p "$OUT" "$CACHE"

WHICH=("$@")
[[ ${#WHICH[@]} -eq 0 ]] && WHICH=(android linux windows macos-arm64 macos-x64)

ENGINE_VERSION="$(tr -d '[:space:]' < "$ENGINE/VERSION" 2>/dev/null || echo unknown)"
BUILT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
# The Electron the desktop kits carry: the one build_app.sh's staged
# package.json resolves to. Pinned here and checked against the release's own
# SHASUMS256.txt on download.
ELECTRON="${DNP_KIT_ELECTRON:-44.4.5}"
TMPMOD="__packager_kit"

# A file's paths, relative, one per line -- the kit's table of contents, so the
# packager can say what a kit holds without unzipping it.
list_files() { (cd "$1" && find . -type f | sed 's|^\./||' | LC_ALL=C sort); }
json_list() { python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))'; }

# --- the throwaway module ------------------------------------------------------
# Global, not local: the EXIT trap runs after a function has returned, when a
# local would already be gone (and `set -u` then kills the cleanup itself).
KIT_TMPMOD_DIR=""
trap '[[ -n "$KIT_TMPMOD_DIR" ]] && rm -rf "$KIT_TMPMOD_DIR"' EXIT

make_tmpmod() {
  local moddir="$REPO/modules/$TMPMOD"
  if [[ -e "$moddir" ]]; then
    echo "[kit] $moddir already exists -- a previous run died; remove it and retry" >&2
    exit 2
  fi
  # Removed whatever happens: it lives in the shared modules/ tree.
  KIT_TMPMOD_DIR="$moddir"
  # Any baked map will do -- the module is thrown away. The smallest one the
  # engine's own test bake leaves, or a fresh bake of a small test map.
  mkdir -p "$moddir/maps"
  local arch; arch="$(uname -m)"; [[ "$arch" == "x86_64" ]] || arch=arm64
  local src="$ENGINE/build/$arch/level_a.dnpm"
  if [[ ! -f "$src" ]]; then
    [[ -x "$ENGINE/build/$arch/mapc" ]] || { echo "[kit] no mapc: run engine/scripts/build_native.sh" >&2; exit 2; }
    "$ENGINE/build/$arch/mapc" "$ENGINE/maps/level_a.map" "$moddir/maps/kit.dnpm" >/dev/null
  else
    cp "$src" "$moddir/maps/kit.dnpm"
  fi
  # build_app.sh reads the name out of module.txt and, under set -e, dies
  # without a word when the file is missing.
  printf 'name Packager kit\n' > "$moddir/module.txt"
}
drop_tmpmod() { rm -rf "$REPO/modules/$TMPMOD"; KIT_TMPMOD_DIR=""; }

# Proof the throwaway module left nothing behind: its name must appear nowhere.
assert_clean() {
  if grep -rlI "$TMPMOD" "$1" >/dev/null 2>&1; then
    echo "[kit] the throwaway module leaked into the kit:" >&2
    grep -rlI "$TMPMOD" "$1" >&2
    exit 1
  fi
}

# -D: no directory entries. Info-ZIP keeps each file's unix mode in the entry's
# external attributes, which is how the desktop kits carry their executables'
# x bits through to the packager (zip.js reads them back).
# .DS_Store (Finder's, copied in by build_app.sh's cp -R) is left out of every
# kit: it is junk in a game, and on macOS codesign's rules omit it from a seal.
pack() { rm -f "${2:?}"; (cd "$1" && zip -qrD "$2" . -x '*.DS_Store'); }

# --- android -------------------------------------------------------------------

kit_android() {
  make_tmpmod
  # --studio so the studio's pages are in the kit; the packager leaves them out
  # of a game that does not ask for them.
  echo "[kit] android  running engine/scripts/build_apk.sh"
  "$ENGINE/scripts/build_apk.sh" --module "$TMPMOD" --studio --no-kits | sed 's/^/        /'
  local apk="$ENGINE/build/android/digidream-$TMPMOD.apk"
  [[ -f "$apk" ]] || { echo "[kit] build_apk.sh produced no $apk" >&2; exit 1; }

  local stage="$OUT/android.stage"
  rm -rf "$stage"; mkdir -p "$stage"
  (cd "$stage" && unzip -q "$apk")
  rm -f "$apk" "$apk.idsig"

  # Out: the signature (the packager signs), the throwaway module's maps and
  # its game tree, and start.txt (written per game). The compiled manifest
  # STAYS: the packager decodes it, renames the package and the label, and
  # encodes it again, so the manifest's source of truth is still the engine's.
  rm -rf "$stage/META-INF" "$stage/assets/web/maps" "$stage/assets/game/modules" \
         "$stage/assets/game/start.txt"
  assert_clean "$stage"

  cat > "$stage/kit.json" <<EOF
{
  "kit": "android",
  "engine": "$ENGINE_VERSION",
  "built": "$BUILT",
  "abi": "$(ls "$stage/lib")",
  "minSdk": 26,
  "files": $(list_files "$stage" | json_list)
}
EOF
  pack "$stage" "$OUT/android.zip"
  rm -rf "$stage"; drop_tmpmod
  echo "[kit] android  $OUT/android.zip  ($(du -h "$OUT/android.zip" | cut -f1), engine $ENGINE_VERSION)"
}

# --- the desktop servers, in containers ------------------------------------------

DOCKER_READY=0
# An image that is there, asked for again a few seconds apart: Docker Desktop
# waking from its resource saver can fail the first command, and treating
# that as "no image" rebuilt the whole image (apt, minutes, a network).
have_image() {
  local i
  for i in 1 2 3 4 5; do docker image inspect "$1" >/dev/null 2>&1 && return 0; sleep 3; done
  return 1
}
docker_ready() {
  [[ $DOCKER_READY -eq 1 ]] && return
  command -v docker >/dev/null && docker info >/dev/null 2>&1 || {
    echo "[kit] the Linux and Windows kits build their servers in Docker, which is not running" >&2; exit 2; }
  local d="$HERE/scripts/docker"
  have_image digidream-kit-servers ||
    docker build --platform linux/amd64 -t digidream-kit-servers -f "$d/Dockerfile" "$d" | tail -1
  have_image digidream-kit-test ||
    docker build --platform linux/amd64 -t digidream-kit-test -f "$d/Dockerfile.test" "$d" | tail -1
  DOCKER_READY=1
}

# The server and the golden trace for one target, built in the toolchain image.
build_server() {
  local t="$1"
  docker_ready
  mkdir -p "$SERVERS"
  echo "[kit] $t  server and golden trace (container)"
  docker run --rm --platform linux/amd64 -v "$REPO":/src:ro -v "$SERVERS":/out \
    digidream-kit-servers bash -c "/src/packager/scripts/docker/servers.sh $t && /src/packager/scripts/docker/trace.sh $t" \
    2>&1 | grep -E '^\[|error' | sed 's/^/        /'
}

# This machine's native golden trace, built exactly as the gate builds it.
HOST_TRACE=""
host_trace() {
  [[ -n "$HOST_TRACE" ]] && return
  HOST_TRACE="$CACHE/trace_host.txt"
  local bin="$CACHE/golden_trace_host"
  (ROOT="$ENGINE"; eval "$(grep -E '^(FLAGS|SRCS)=\(' "$ENGINE/scripts/check_determinism.sh")"
   clang++ "${FLAGS[@]}" "${SRCS[@]}" -o "$bin")
  { "$bin" --chunks; "$bin" "${TICKS:-10000}"; } > "$HOST_TRACE"
}

# The target's trace, run where it runs (natively in Linux, Windows under Wine),
# must be the host's byte for byte.
check_trace() {
  local t="$1" run
  host_trace
  case "$t" in
    linux)   run='b=linux-x64/golden_trace; { $b --chunks; $b '"${TICKS:-10000}"'; }' ;;
    windows) run='b="/usr/lib/wine/wine64 windows-x64/golden_trace.exe"; { $b --chunks; $b '"${TICKS:-10000}"'; } 2>/dev/null | tr -d "\r"' ;;
  esac
  docker run --rm --platform linux/amd64 -v "$SERVERS":/s:ro digidream-kit-test bash -c "cd /s && $run" > "$CACHE/trace_$t.txt"
  if ! cmp -s "$HOST_TRACE" "$CACHE/trace_$t.txt"; then
    echo "[kit] $t: the golden trace DIFFERS from this machine's native one -- refusing the kit" >&2
    diff "$HOST_TRACE" "$CACHE/trace_$t.txt" | head -5 >&2
    exit 1
  fi
  echo "[kit] $t  determinism: $(wc -l < "$HOST_TRACE" | tr -d ' ') trace lines identical to native $(uname -m)"
}

electron_zip() {
  local plat="$1" f="electron-v$ELECTRON-$1.zip"
  local sums="$CACHE/SHASUMS256-v$ELECTRON.txt"
  [[ -f "$sums" ]] || curl -fsSL -o "$sums" "https://github.com/electron/electron/releases/download/v$ELECTRON/SHASUMS256.txt"
  if [[ ! -f "$CACHE/$f" ]]; then
    echo "[kit] downloading $f" >&2
    curl -fsSL -o "$CACHE/$f.part" "https://github.com/electron/electron/releases/download/v$ELECTRON/$f"
    mv "$CACHE/$f.part" "$CACHE/$f"
  fi
  local want have
  want="$(grep " \*$f\$" "$sums" | cut -d' ' -f1)"
  have="$(shasum -a 256 "$CACHE/$f" | cut -d' ' -f1)"
  [[ -n "$want" && "$want" == "$have" ]] || { echo "[kit] $f does not match the release's SHASUMS256.txt" >&2; rm -f "$CACHE/$f"; exit 1; }
  echo "$CACHE/$f"
}

# --- linux, windows ----------------------------------------------------------------

kit_desktop() {
  local t="$1" plat exe server
  case "$t" in
    linux)   plat=linux-x64;   exe=electron;     server="$SERVERS/linux-x64/dnp-server" ;;
    windows) plat=win32-x64;   exe=electron.exe; server="$SERVERS/windows-x64/dnp-server.exe" ;;
  esac
  build_server "$t"
  [[ -f "$server" ]] || { echo "[kit] $t: no server at $server" >&2; exit 1; }
  check_trace "$t"
  local ezip; ezip="$(electron_zip "$plat")"

  # The engine tree, staged by the engine's own script on the throwaway module.
  make_tmpmod
  local stage="$OUT/$t.stage"
  rm -rf "$stage"; mkdir -p "$stage"
  echo "[kit] $t  running engine/scripts/build_app.sh"
  "$ENGINE/scripts/build_app.sh" --module "$TMPMOD" --studio --no-kits --out "$stage/staging" | sed 's/^/        /'
  mv "$stage/staging/$TMPMOD" "$stage/app"
  rm -rf "$stage/staging"
  # Out: the throwaway module, the two files that name the game (written per
  # game), Electron's npm stub, and the HOST's server -- in goes the target's.
  rm -rf "$stage/app/modules" "$stage/app/game.json" "$stage/app/package.json" \
         "$stage/app/node_modules" "$stage/app/bin"
  mkdir -p "$stage/app/bin"
  cp "$server" "$stage/app/bin/"
  chmod 755 "$stage/app/bin/"*
  assert_clean "$stage"
  drop_tmpmod

  mkdir -p "$stage/runtime"
  (cd "$stage/runtime" && unzip -q "$ezip")
  # Electron's placeholder app; the game's resources/app is what runs.
  rm -f "$stage/runtime/resources/default_app.asar"

  cat > "$stage/kit.json" <<EOF
{
  "kit": "$t",
  "engine": "$ENGINE_VERSION",
  "built": "$BUILT",
  "arch": "x64",
  "electron": "$ELECTRON",
  "exe": "$exe",
  "server": "app/bin/$(basename "$server")",
  "files": $(list_files "$stage" | json_list)
}
EOF
  pack "$stage" "$OUT/$t.zip"
  rm -rf "$stage"
  echo "[kit] $t  $OUT/$t.zip  ($(du -h "$OUT/$t.zip" | cut -f1), engine $ENGINE_VERSION, electron $ELECTRON)"
}

# --- macos ----------------------------------------------------------------------
#
# Built HERE, natively: this script runs on a Mac (codesign is Apple's). The
# server for each arch is build_server.sh's, for macOS 12 and up (Electron 44
# asks for 13); Intel's is cross-compiled with -arch x86_64 against a LuaJIT
# built for x86-64, whose build tools run under Rosetta.
#
# SIGNING. Electron ships linker-signed only, which `codesign --verify --deep
# --strict` rejects and Gatekeeper calls "damaged". Every NESTED piece (the
# framework, the four helper apps, their libraries) is signed here, ad hoc,
# by the real codesign -- none of it changes from game to game -- and their
# cdhashes go into kit.json. The packager page then seals and signs only the
# outer bundle, which is what each game changes (src/macos.js).

MAC_MIN=12.0

luajit_macos_x64() {
  local d="${CACHE:?}/luajit-macos-x64"
  if [[ -f "$d/src/libluajit.a" ]]; then echo "$d"; return; fi
  rm -rf "${d:?}"; mkdir -p "$d"
  (cd "$ENGINE/third_party/luajit" && tar --exclude='*.o' --exclude='*.a' --exclude='*.so' \
     --exclude='src/luajit' --exclude='src/host/minilua' --exclude='src/host/buildvm' -cf - .) | tar -xf - -C "$d"
  echo "[kit] macos-x64  luajit (x86-64, host tools under Rosetta)" >&2
  MACOSX_DEPLOYMENT_TARGET=11.0 make -C "$d" -j8 amalg BUILDMODE=static \
    HOST_CC="clang -arch x86_64" TARGET_FLAGS="-arch x86_64" >/dev/null 2>&1 ||
    { echo "[kit] LuaJIT for x86-64 did not build (is Rosetta installed?)" >&2; exit 1; }
  echo "$d"
}

# The macOS server for one arch, checked against the golden trace: shared by
# the Electron kit (kit_macos) and the Tauri one (kit_tauri_macos). Built once
# per run.
mac_server() {
  local arch="$1" ljdir="" archflag t="macos-$1"
  # A plain variable per arch, not an associative array: macOS's bash is 3.2.
  local done_flag="MAC_SERVER_DONE_$arch"
  [[ -n "${!done_flag:-}" ]] && return
  case "$arch" in
    arm64) archflag="-arch arm64" ;;
    x64)   archflag="-arch x86_64"; ljdir="$(luajit_macos_x64)" ;;
  esac
  echo "[kit] $t  server (native build_server.sh, macOS $MAC_MIN+)"
  if [[ -n "$ljdir" ]]; then
    DNP_LUAJIT_DIR="$ljdir" DNP_SERVER_OUT="$SERVERS/$t" DNP_SERVER_LDFLAGS="$archflag -mmacosx-version-min=$MAC_MIN" \
      "$ENGINE/scripts/build_server.sh" | sed 's/^/        /'
  else
    DNP_SERVER_OUT="$SERVERS/$t" DNP_SERVER_LDFLAGS="$archflag -mmacosx-version-min=$MAC_MIN" \
      "$ENGINE/scripts/build_server.sh" | sed 's/^/        /'
  fi

  # The golden trace, built the gate's way for this arch and minimum, run here
  # (x86-64 under Rosetta), must be the host's native one.
  host_trace
  (ROOT="$ENGINE"; eval "$(grep -E '^(FLAGS|SRCS)=\(' "$ENGINE/scripts/check_determinism.sh")"
   clang++ "${FLAGS[@]}" $archflag -mmacosx-version-min=$MAC_MIN "${SRCS[@]}" -o "$SERVERS/$t/golden_trace")
  { "$SERVERS/$t/golden_trace" --chunks; "$SERVERS/$t/golden_trace" "${TICKS:-10000}"; } > "$CACHE/trace_$t.txt"
  cmp -s "$HOST_TRACE" "$CACHE/trace_$t.txt" || { echo "[kit] $t: the golden trace DIFFERS from native -- refusing the kit" >&2; exit 1; }
  echo "[kit] $t  determinism: $(wc -l < "$HOST_TRACE" | tr -d ' ') trace lines identical to native $(uname -m)"
  printf -v "$done_flag" 1
}

kit_macos() {
  local arch="$1" eplat
  [[ "$(uname -s)" == "Darwin" ]] || { echo "[kit] the macOS kits are built on a Mac" >&2; exit 2; }
  case "$arch" in
    arm64) eplat=darwin-arm64 ;;
    x64)   eplat=darwin-x64 ;;
  esac
  local t="macos-$arch"
  mac_server "$arch"

  local ezip; ezip="$(electron_zip "$eplat")"
  make_tmpmod
  local stage="${OUT:?}/${t:?}.stage"
  rm -rf "${stage:?}"; mkdir -p "$stage/runtime"
  echo "[kit] $t  running engine/scripts/build_app.sh"
  "$ENGINE/scripts/build_app.sh" --module "$TMPMOD" --studio --no-kits --out "$stage/staging" | grep -E '^\[app\] (staged|NO )' | sed 's/^/        /'
  mv "$stage/staging/$TMPMOD" "$stage/app"
  rm -rf "${stage:?}/staging" "${stage:?}/app/modules" "${stage:?}/app/game.json" "${stage:?}/app/package.json" \
         "${stage:?}/app/node_modules" "${stage:?}/app/bin"
  mkdir -p "$stage/app/bin"; cp "$SERVERS/$t/dnp-server" "$stage/app/bin/"; chmod 755 "$stage/app/bin/dnp-server"
  assert_clean "$stage"
  drop_tmpmod

  ditto -x -k "$ezip" "$stage/runtime"
  local A="$stage/runtime/Electron.app"
  rm -f "${A:?}/Contents/Resources/default_app.asar"
  echo "[kit] $t  signing the nested bundles ad hoc (codesign)"
  codesign -s - -f --deep "$A" 2>&1 | grep -v 'replacing existing signature' | sed 's/^/        /' || true
  local nested="" b cd
  for b in "$A/Contents/Frameworks/"*; do
    cd="$(codesign -dvvv "$b" 2>&1 | sed -n 's/^CDHash=//p')"
    [[ ${#cd} -eq 40 ]] || { echo "[kit] no cdhash for $b" >&2; exit 1; }
    [[ -n "$nested" ]] && nested+=", "
    nested+="{ \"path\": \"Frameworks/$(basename "$b")\", \"cdhash\": \"$cd\" }"
  done

  cat > "$stage/kit.json" <<EOF
{
  "kit": "macos",
  "engine": "$ENGINE_VERSION",
  "built": "$BUILT",
  "arch": "$arch",
  "electron": "$ELECTRON",
  "bundle": "runtime/Electron.app",
  "server": "app/bin/dnp-server",
  "nested": [$nested],
  "files": $(list_files "$stage" | json_list)
}
EOF
  # -y: symlinks stay symlinks (a framework is made of them).
  rm -f "${OUT:?}/${t:?}.zip"; (cd "$stage" && zip -qryD "$OUT/$t.zip" . -x '*.DS_Store')
  rm -rf "${stage:?}"
  echo "[kit] $t  $OUT/$t.zip  ($(du -h "$OUT/$t.zip" | cut -f1), engine $ENGINE_VERSION, electron $ELECTRON)"
}

# --- tauri -----------------------------------------------------------------------
#
# The OPTION beside Electron (which stays the default): a game in the OS's own
# web view. A Tauri kit is the runner (shells/tauri, Rust, a few MB) and the
# server for one OS, plus the shim the page's shell.js is given and a default
# icon. The web and server trees come from the ANDROID kit when a game is
# built (src/tauri.js), so both kits must share an engine version.

TAURI_DIR="$HERE/shells/tauri"
TAURI_TARGET="$HERE/build/tauri-target"

# Pack a Tauri kit from a runner and a server. $1 kit name, $2 os, $3 arch,
# $4 runner file, $5 server file.
pack_tauri_kit() {
  local name="$1" os="$2" arch="$3" runner="$4" server="$5"
  local stage="${OUT:?}/${name:?}.stage"
  rm -rf "${stage:?}"; mkdir -p "$stage/runner" "$stage/bin" "$stage/web"
  cp "$runner" "$stage/runner/"; chmod 755 "$stage/runner/"*
  cp "$server" "$stage/bin/"; chmod 755 "$stage/bin/"*
  cp "$TAURI_DIR/web/tauri-native.js" "$stage/web/"
  cp "$TAURI_DIR/icons/icon.icns" "$stage/icon.icns"
  cat > "$stage/kit.json" <<EOF
{
  "kit": "tauri",
  "os": "$os",
  "arch": "$arch",
  "engine": "$ENGINE_VERSION",
  "built": "$BUILT",
  "runner": "runner/$(basename "$runner")",
  "server": "bin/$(basename "$server")",
  "shim": "web/tauri-native.js",
  "icon": "icon.icns",
  "files": $(list_files "$stage" | json_list)
}
EOF
  pack "$stage" "$OUT/$name.zip"
  rm -rf "${stage:?}"
  echo "[kit] $name  $OUT/$name.zip  ($(du -h "$OUT/$name.zip" | cut -f1), engine $ENGINE_VERSION)"
}

kit_tauri_macos() {
  local arch="$1" target
  [[ "$(uname -s)" == "Darwin" ]] || { echo "[kit] the macOS kits are built on a Mac" >&2; exit 2; }
  case "$arch" in
    arm64) target=aarch64-apple-darwin ;;
    x64)   target=x86_64-apple-darwin ;;
  esac
  mac_server "$arch"
  command -v cargo >/dev/null || { echo "[kit] Tauri kits need Rust (cargo) -- https://rustup.rs" >&2; exit 2; }
  rustup target list --installed 2>/dev/null | grep -qx "$target" || rustup target add "$target"
  echo "[kit] tauri-macos-$arch  runner (cargo, $target, macOS $MAC_MIN+)"
  (cd "$TAURI_DIR" && MACOSX_DEPLOYMENT_TARGET=$MAC_MIN cargo build --release --target "$target" --target-dir "$TAURI_TARGET" 2>&1 \
     | grep -E '^(error|warning)|Finished' | sed 's/^/        /')
  local runner="$TAURI_TARGET/$target/release/digidream-runner"
  [[ -f "$runner" ]] || { echo "[kit] no runner at $runner" >&2; exit 1; }
  # SIGNED HERE, ad hoc. The linker signs only arm64 output on its own, so a
  # cross-built x86-64 runner has no LC_CODE_SIGNATURE -- and the page re-signs
  # a game's runner by refilling that slot (src/macho.js), it does not add one.
  codesign -s - -f "$runner" 2>&1 | grep -v 'replacing existing signature' || true
  codesign -s - -f "$SERVERS/macos-$arch/dnp-server" 2>&1 | grep -v 'replacing existing signature' || true
  pack_tauri_kit "tauri-macos-$arch" macos "$arch" "$runner" "$SERVERS/macos-$arch/dnp-server"
}

# Linux and Windows runners, built in packager/scripts/docker/Dockerfile.tauri;
# the servers are the same container builds the Electron kits use, checked
# against the golden trace the same way.
kit_tauri_docker() {
  local os="$1" runner server
  docker_ready
  have_image digidream-kit-tauri ||
    docker build --platform linux/amd64 -t digidream-kit-tauri -f "$HERE/scripts/docker/Dockerfile.tauri" "$HERE/scripts/docker" | tail -1
  build_server "$os"
  check_trace "$os"
  local target="$HERE/build/tauri-target-$os"
  mkdir -p "$target"
  echo "[kit] tauri-$os  runner (cargo in a container; the first build takes a while)"
  # The crate is copied in: tauri-build writes gen/ beside its sources. The
  # cargo registry lives in a named volume so later builds do not refetch it.
  local cmd='cp -R /src/packager/shells/tauri /work/runner && cd /work/runner && '
  if [[ "$os" == "windows" ]]; then
    cmd+='cargo xwin build --release --target x86_64-pc-windows-msvc --target-dir /target'
    runner="$target/x86_64-pc-windows-msvc/release/digidream-runner.exe"
    server="$SERVERS/windows-x64/dnp-server.exe"
  else
    cmd+='cargo build --release --target-dir /target'
    runner="$target/release/digidream-runner"
    server="$SERVERS/linux-x64/dnp-server"
  fi
  docker run --rm --platform linux/amd64 -v "$REPO":/src:ro -v "$target":/target -v dnp-cargo-registry:/opt/cargo/registry \
    digidream-kit-tauri bash -c "$cmd" 2>&1 | grep -E '^(error|warning: unused)|Finished' | sed 's/^/        /'
  [[ -f "$runner" ]] || { echo "[kit] no runner at $runner" >&2; exit 1; }
  pack_tauri_kit "tauri-$os" "$os" x64 "$runner" "$server"
}

for k in "${WHICH[@]}"; do
  case "$k" in
    android) kit_android ;;
    linux|windows) kit_desktop "$k" ;;
    macos-arm64) kit_macos arm64 ;;
    macos-x64) kit_macos x64 ;;
    tauri-macos-arm64) kit_tauri_macos arm64 ;;
    tauri-macos-x64) kit_tauri_macos x64 ;;
    tauri-linux|tauri-windows) kit_tauri_docker "${k#tauri-}" ;;
    *) echo "[kit] unknown kit: $k (known: android linux windows macos-arm64 macos-x64 tauri-linux tauri-windows tauri-macos-arm64 tauri-macos-x64)" >&2; exit 2 ;;
  esac
done
