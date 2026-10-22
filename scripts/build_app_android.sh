#!/usr/bin/env bash
#
# Builds the packager's ANDROID APP: shells/android (one activity, a WebView)
# with the packager page and the Android kit in its assets.
#
#   packager/scripts/build_app_android.sh                # -> packager/build/apps/digidream-packager.apk
#   packager/scripts/build_app_android.sh --debuggable   # inspectable over USB (the tests drive it)
#
# The same SDK tools as engine/scripts/build_apk.sh and nothing downloaded:
# aapt2, javac, d8, zipalign, apksigner. No NDK -- the packager has no native
# code -- and no Gradle or AndroidX. Signed with a key of its own, kept in
# packager/build/ (gitignored): the same key every build, so a new version
# installs over the last.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHELL_DIR="$HERE/shells/android"
OUT="$HERE/build/android-app"
APPS="$HERE/build/apps"
DEBUGGABLE=0
for a in "$@"; do
  case "$a" in
    --debuggable) DEBUGGABLE=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
[[ -d "$SDK" ]] || { echo "[app] no Android SDK at $SDK (set ANDROID_HOME)" >&2; exit 2; }
pick_newest () { ls "$1" 2>/dev/null | sort -V | tail -1; }
BT="$SDK/build-tools/${DNP_BUILD_TOOLS:-$(pick_newest "$SDK/build-tools")}"
PLATFORM_JAR=""
for p in android-34 android-35 android-36 $(pick_newest "$SDK/platforms"); do
  [[ -f "$SDK/platforms/$p/android.jar" ]] && { PLATFORM_JAR="$SDK/platforms/$p/android.jar"; break; }
done
for t in "$BT/aapt2" "$BT/d8" "$BT/apksigner" "$BT/zipalign"; do [[ -x "$t" ]] || { echo "[app] missing $t" >&2; exit 2; }; done
[[ -n "$PLATFORM_JAR" ]] || { echo "[app] no android.jar under $SDK/platforms" >&2; exit 2; }
command -v javac >/dev/null || { echo "[app] no javac on PATH" >&2; exit 2; }
[[ -f "$HERE/build/kits/android.zip" ]] || { echo "[app] no Android kit -- run packager/scripts/build_kits.sh android" >&2; exit 2; }

rm -rf "${OUT:?}"; mkdir -p "$OUT/stage/assets/www/src" "$OUT/stage/assets/www/kits" "$OUT/res/mipmap-anydpi-v26" "$OUT/res/drawable" "$OUT/res/values" "$OUT/res/mipmap" "$OUT/gen" "$APPS"

# --- the page and the kit it ships with ------------------------------------------
cp "$HERE/index.html" "$OUT/stage/assets/www/"
cp "$HERE"/src/*.js "$OUT/stage/assets/www/src/"
cp "$SHELL_DIR/android-host.js" "$OUT/stage/assets/www/"
cp "$HERE/build/kits/android.zip" "$OUT/stage/assets/www/kits/"
# The Tauri kits (a few MB each) ship too, when their engine matches the
# Android kit's: the phone can then build small desktop games out of the box.
ANDROID_ENGINE="$(unzip -p "$HERE/build/kits/android.zip" kit.json | sed -n 's/.*"engine": "\([^"]*\)".*/\1/p')"
for k in "$HERE"/build/kits/tauri-*.zip; do
  [[ -f "$k" ]] || continue
  e="$(unzip -p "$k" kit.json | sed -n 's/.*"engine": "\([^"]*\)".*/\1/p')"
  if [[ "$e" == "$ANDROID_ENGINE" ]]; then cp "$k" "$OUT/stage/assets/www/kits/"; echo "[app] android  bundling $(basename "$k")"
  else echo "[app] android  NOT bundling $(basename "$k"): engine $e, the Android kit is $ANDROID_ENGINE"; fi
done

# --- the launcher icon: the packager's parcel (shells/icon/icon.svg), as an
# adaptive icon's foreground, drawn in the safe 66 dp of its 108.
cat > "$OUT/res/drawable/ic_fg.xml" <<'XML'
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
  <path android:strokeColor="#ffffff" android:strokeWidth="3.2" android:strokeLineJoin="round" android:strokeLineCap="round"
        android:pathData="M54,36 L70.56,44.64 L70.56,63.36 L54,72 L37.44,63.36 L37.44,44.64 Z M37.44,44.64 L54,53.28 L70.56,44.64 M54,53.28 L54,72" />
  <path android:strokeColor="#d9ffffff" android:strokeWidth="2.45" android:strokeLineJoin="round" android:strokeLineCap="round"
        android:pathData="M45.72,40.32 L62.28,48.96 L62.28,55.44" />
</vector>
XML
cat > "$OUT/res/values/colors.xml" <<'XML'
<resources><color name="ic_bg">#2f6fdb</color></resources>
XML
cat > "$OUT/res/mipmap-anydpi-v26/ic_launcher.xml" <<'XML'
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/ic_bg" />
  <foreground android:drawable="@drawable/ic_fg" />
</adaptive-icon>
XML
cp "$OUT/res/drawable/ic_fg.xml" "$OUT/res/mipmap/ic_launcher.xml"

VERSION="$(tr -d '[:space:]' < "$HERE/VERSION")"
# versionCode from the version, with room for a dev release's fourth part (as
# the studio's): 0.1.2 -> 10200, 0.1.2.1 -> 10201, 1.2.3 -> 1020300. Every code
# is above the old three-part one (0.1.2 was 102), so an APK still installs
# over the one before it.
IFS=. read -r MA MI PA DV <<< "$VERSION"
CODE=$(( 10#${MA:-0} * 1000000 + 10#${MI:-0} * 10000 + 10#${PA:-0} * 100 + 10#${DV:-0} ))

echo "[app] android  resources and manifest (version $VERSION, code $CODE)"
"$BT/aapt2" compile --dir "$OUT/res" -o "$OUT/res.zip" >/dev/null
LINK=(--min-sdk-version 26 --target-sdk-version 34 --version-code "$CODE" --version-name "$VERSION")
[[ $DEBUGGABLE -eq 1 ]] && LINK+=(--debug-mode)
"$BT/aapt2" link -I "$PLATFORM_JAR" --manifest "$SHELL_DIR/AndroidManifest.xml" --java "$OUT/gen" \
  "${LINK[@]}" -o "$OUT/base.apk" "$OUT/res.zip" >/dev/null

echo "[app] android  java"
find "$SHELL_DIR/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
mkdir -p "$OUT/classes"
javac -source 8 -target 8 -nowarn -Xlint:none \
  -bootclasspath "$PLATFORM_JAR:$BT/core-lambda-stubs.jar" -d "$OUT/classes" @"$OUT/sources.txt" 2>&1 \
  | grep -vE "^(Note:|warning:|[0-9]+ warning)" || true
[[ -f "$OUT/classes/com/digidream/packager/MainActivity.class" ]] || { echo "[app] javac produced no MainActivity" >&2; exit 2; }
"$BT/d8" --min-api 26 --output "$OUT/stage" $(find "$OUT/classes" -name '*.class') >/dev/null

echo "[app] android  packing"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
# The kit is stored, not deflated again: it is already a zip.
(cd "$OUT/stage" && zip -q -X -r "$OUT/unsigned.apk" classes.dex assets -x 'assets/www/kits/*' && zip -q -X -0 -r "$OUT/unsigned.apk" assets/www/kits)

KEY="$HERE/build/packager-app.keystore"
if [[ ! -f "$KEY" ]]; then
  echo "[app] android  generating the app's signing key ($KEY)"
  keytool -genkeypair -keystore "$KEY" -storepass packager -keypass packager -alias packager \
    -keyalg RSA -keysize 3072 -validity 10950 -dname "CN=Digidream Packager,O=Digidream" >/dev/null 2>&1
fi
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
APK="$APPS/digidream-packager.apk"
"$BT/apksigner" sign --ks "$KEY" --ks-pass pass:packager --key-pass pass:packager --out "$APK" "$OUT/aligned.apk"
rm -f "$APK.idsig"
rm -rf "${OUT:?}"
echo "[app] android  $APK  ($(du -h "$APK" | cut -f1))$([[ $DEBUGGABLE -eq 1 ]] && echo '  DEBUGGABLE')"
