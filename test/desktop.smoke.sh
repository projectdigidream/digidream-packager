#!/usr/bin/env bash
#
# A packaged LINUX game, run: unpacked, started as an ordinary user on a
# virtual display, and required to start its server and put a player in a
# level; then the screen is captured.
#
#   docker run --rm --platform linux/amd64 --shm-size=512m \
#     -v "$PWD/packager/build/test":/t -v "$PWD/packager/test":/smoke:ro \
#     digidream-kit-desktop /smoke/desktop.smoke.sh /t/<Name>-linux-x64.tar.gz /t/<name>.png
#
# Runs in packager/scripts/docker/Dockerfile.desktop. The container has no GPU,
# so the client is told to use Chromium's software renderer (the launcher
# passes arguments through); a real desktop needs no flags.
set -uo pipefail
TARBALL="$1"; SHOT="$2"; SECS="${SMOKE_SECS:-25}"
useradd -m player >/dev/null 2>&1 || true
cd /home/player && tar -xzf "$TARBALL" && chown -R player .
GAME="$(ls -d /home/player/*/ | head -1)"
LAUNCHER="$(find "$GAME" -maxdepth 1 -type f -perm -u+x -name '*' ! -name '*.bin' ! -name '*.so*' ! -name 'chrome*' | head -1)"
echo "[smoke] game $GAME, launcher $LAUNCHER"
Xvfb :99 -screen 0 1280x720x24 >/dev/null 2>&1 &
sleep 1
su player -c "cd '$GAME' && DISPLAY=:99 timeout $SECS '$LAUNCHER' --use-angle=swiftshader --enable-unsafe-swiftshader" > /tmp/game.log 2>&1 &
for i in $(seq 1 "$SECS"); do grep -q 'session 1 -> level' /tmp/game.log && break; sleep 1; done
sleep 8
DISPLAY=:99 xwd -root -silent | convert xwd:- "$SHOT" 2>/dev/null
grep -E '^\[(app|srv|link|page)\]' /tmp/game.log | grep -vE 'level 0: |grid:|nav:' | head -20
fails=0
grep -q '\[app\] server: ' /tmp/game.log || { echo "[smoke] FAIL the shell did not start the server"; fails=1; }
grep -q 'session 1 -> level' /tmp/game.log || { echo "[smoke] FAIL no player joined a level"; fails=1; }
if grep -qE 'Uncaught|FATAL' /tmp/game.log; then echo "[smoke] FAIL page or process errors:"; grep -E 'Uncaught|FATAL' /tmp/game.log | head -5; fails=1; fi
[[ $fails -eq 0 ]] && echo "[smoke] ok: the game started its server, joined a level, and drew ($SHOT)"
exit $fails
