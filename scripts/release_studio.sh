#!/usr/bin/env bash
#
# THE WHOLE ROUND: the packager's kits built again from today's engine and
# studio, then the studio for every platform it runs on, from those kits.
#
#   packager/scripts/release_studio.sh               # every kit, every studio
#   packager/scripts/release_studio.sh --skip-kits   # the studios only, from the kits there are
#   packager/scripts/release_studio.sh --kits "android macos-arm64"   # just these kits first
#
# 1. KITS (build_kits.sh): android, the Electron desktops (linux, windows,
#    macos-arm64, macos-x64) and the Tauri ones. They carry the engine and the
#    studio's pages as they are now, so this is what makes the packager --
#    and the studio's own Package page -- build games with today's engine.
# 2. THE STUDIO, from them:
#    - Android: engine/scripts/build_apk.sh --module starter --studio (the same
#      debug key and package as every studio APK before: a phone updates in
#      place and keeps its modules);
#    - Linux, Windows, macOS arm64 and x64: build_studio.mjs, the packager's
#      own builders with the studio switched on.
#    Everything lands in builds/, at the repository's root (not in git).
#
# Needs: the Android SDK + NDK; Docker (the Linux and Windows servers and the
# Tauri runners are built in containers); Rust with the macOS targets (the
# Tauri macOS runners); network the first time (Electron downloads).
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OUT="$REPO/builds"
ALL_KITS="android linux windows macos-arm64 macos-x64 tauri-macos-arm64 tauri-macos-x64 tauri-linux tauri-windows"

KITS="$ALL_KITS"
SKIP_KITS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-kits) SKIP_KITS=1; shift ;;
    --kits) KITS="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

ENGINE_VERSION="$(tr -d '[:space:]' < "$REPO/engine/VERSION")"
STUDIO_VERSION="$(tr -d '[:space:]' < "$REPO/studio/VERSION")"
echo "[release] engine $ENGINE_VERSION, studio $STUDIO_VERSION"
T0=$SECONDS

# --- what is needed, said before anything runs -----------------------------------
# A kit build that dies an hour in, on a missing tool, is the failure this
# avoids.
problems=()
need_docker=0
for k in $KITS; do case "$k" in linux|windows|tauri-linux|tauri-windows) need_docker=1 ;; esac; done
if [[ $SKIP_KITS -eq 0 && $need_docker -eq 1 ]] && ! docker info >/dev/null 2>&1; then
  problems+=("Docker is not running (the Linux and Windows kits are built in containers): start Docker Desktop, or leave those kits out with --kits")
fi
# Free space: a kit build writes many gigabytes inside Docker's disk image and
# the cargo targets, and Docker dies, not fails, when the disk fills (it did,
# 2026-10-10, half way through the Windows kit). The studios alone need ~1 GB.
free_gb=$(df -g "$HERE" | awk 'NR==2{print $4}')
min_gb=3; [[ $SKIP_KITS -eq 0 ]] && min_gb=15
if [[ "${free_gb:-0}" -lt $min_gb ]]; then
  problems+=("only ${free_gb} GB free; $( [[ $SKIP_KITS -eq 0 ]] && echo 'building the kits' || echo 'the studio builds' ) want ${min_gb} GB or more (docker system df, the emulator's data disk and packager/build are the usual places to look)")
fi
if [[ ! -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}" ]]; then
  problems+=("no Android SDK at ${ANDROID_HOME:-$HOME/Library/Android/sdk} (the Android kit and the studio APK)")
fi
if [[ ! -f "$REPO/studio/wasm/dist/mapc.mjs" ]]; then
  problems+=("no studio map compiler (studio/wasm/dist/mapc.mjs): engine/scripts/build_mapc_wasm.sh")
fi
if ! node "$REPO/studio/tools/vendor_plugins.mjs" --check >/dev/null 2>&1; then
  problems+=("the studio's plugins are not as vendored: node studio/tools/vendor_plugins.mjs")
fi
if [[ ${#problems[@]} -gt 0 ]]; then
  for p in "${problems[@]}"; do echo "[release] CANNOT START: $p" >&2; done
  exit 2
fi

# --- 1. the kits -------------------------------------------------------------------
if [[ $SKIP_KITS -eq 0 ]]; then
  echo "[release] 1/3 kits: $KITS"
  # shellcheck disable=SC2086
  "$HERE/scripts/build_kits.sh" $KITS
else
  echo "[release] 1/3 kits: skipped (--skip-kits)"
fi
# Every kit the studios are made from must be today's engine.
stale=$(cd "$HERE/build/kits" && for f in *.zip; do
  v=$(unzip -p "$f" kit.json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("engine",""))' 2>/dev/null || true)
  [[ "$v" == "$ENGINE_VERSION" ]] || echo "${f%.zip} ($v)"
done)
[[ -n "$stale" ]] && echo "[release] WARNING kits not at engine $ENGINE_VERSION: $(echo $stale)"

# --- 2. the Android studio ---------------------------------------------------------
echo "[release] 2/3 the studio for Android"
mkdir -p "$OUT"
"$REPO/engine/scripts/build_apk.sh" --module starter --studio --icon | grep -E '^\[apk\] (studio|assets|/)' | sed 's/^/        /'
cp "$REPO/engine/build/android/digidream-starter.apk" "$OUT/Digidream Studio-android.apk"
# And without its bundled plugins (build_apk.sh --no-plugins): the same app id,
# so a phone has one or the other.
"$REPO/engine/scripts/build_apk.sh" --module starter --studio --icon --no-plugins | grep -E '^\[apk\] (studio|assets|/)' | sed 's/^/        /'
cp "$REPO/engine/build/android/digidream-starter.apk" "$OUT/Digidream Studio (no plugins)-android.apk"

# --- 3. the desktop studios --------------------------------------------------------
echo "[release] 3/3 the studio for Linux, Windows and macOS"
node "$HERE/scripts/build_studio.mjs"
node "$HERE/scripts/build_studio.mjs" --no-plugins

echo "[release] done in $(( (SECONDS - T0) / 60 )) min -- engine $ENGINE_VERSION, studio $STUDIO_VERSION:"
(cd "$OUT" && for f in *; do printf "        %-40s %s\n" "$f" "$(du -h "$f" | cut -f1)"; done)
