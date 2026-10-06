#!/usr/bin/env bash
#
# Builds the ENGINE KITS the packager assembles games from.
#
#   packager/scripts/build_kits.sh                 # every kit this machine can build
#   packager/scripts/build_kits.sh android
#
# WHY KITS. Nothing compiled into a game depends on its module: the server reads
# the module's files at run time, the Java shell reads start.txt, the client is
# the browser's. So the binaries are built ONCE per engine version, here, by the
# engine's own scripts, and the packager -- a page in a browser, on any machine,
# with no SDK -- only lays a module's files beside them, writes the manifest
# fields that name the game, and signs. A kit is a zip plus kit.json.
#
# NOT A SECOND BUILD. Each kit is cut out of what the engine's script produces,
# so the staging rules live in exactly one place. For Android that means
# scripts/build_apk.sh is run on a throwaway module holding one tiny map and
# nothing else; everything that module put in the APK is then removed, and what
# remains is the engine's part and nothing but.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ENGINE="$REPO/engine"
OUT="$HERE/build/kits"
mkdir -p "$OUT"

WHICH=("$@")
[[ ${#WHICH[@]} -eq 0 ]] && WHICH=(android)

ENGINE_VERSION="$(tr -d '[:space:]' < "$ENGINE/VERSION" 2>/dev/null || echo unknown)"
BUILT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# A file's paths, relative, one per line -- the kit's table of contents, so the
# packager can say what a kit holds without unzipping it.
list_files() { (cd "$1" && find . -type f | sed 's|^\./||' | LC_ALL=C sort); }

# Global, not local: the EXIT trap runs after the function has returned, when a
# local would already be gone (and `set -u` then kills the cleanup itself).
KIT_TMPMOD_DIR=""
trap '[[ -n "$KIT_TMPMOD_DIR" ]] && rm -rf "$KIT_TMPMOD_DIR"' EXIT

kit_android() {
  local tmpmod="__packager_kit"
  local moddir="$REPO/modules/$tmpmod"
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

  # --studio so the studio's pages are in the kit; the packager leaves them out
  # of a game that does not ask for them.
  echo "[kit] android  running engine/scripts/build_apk.sh"
  "$ENGINE/scripts/build_apk.sh" --module "$tmpmod" --studio | sed 's/^/        /'
  local apk="$ENGINE/build/android/digidream-$tmpmod.apk"
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
  # Proof the module left nothing behind: its name must appear nowhere.
  if grep -rlI "$tmpmod" "$stage" >/dev/null 2>&1; then
    echo "[kit] the throwaway module leaked into the kit:" >&2
    grep -rlI "$tmpmod" "$stage" >&2
    exit 1
  fi

  local abi minsdk
  abi="$(ls "$stage/lib")"
  minsdk=26
  cat > "$stage/kit.json" <<EOF
{
  "kit": "android",
  "engine": "$ENGINE_VERSION",
  "built": "$BUILT",
  "abi": "$abi",
  "minSdk": $minsdk,
  "files": $(list_files "$stage" | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')
}
EOF
  rm -f "$OUT/android.zip"
  # -X: no extra attributes; -D: no directory entries. The order is irrelevant:
  # the packager reads the central directory.
  (cd "$stage" && zip -qrXD "$OUT/android.zip" .)
  rm -rf "$stage" "$moddir"
  KIT_TMPMOD_DIR=""
  echo "[kit] android  $OUT/android.zip  ($(du -h "$OUT/android.zip" | cut -f1), engine $ENGINE_VERSION)"
}

for k in "${WHICH[@]}"; do
  case "$k" in
    android) kit_android ;;
    *) echo "[kit] unknown kit: $k (known: android)" >&2; exit 2 ;;
  esac
done
