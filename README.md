# Packager

A module in, a game out, in a browser page. Pick a module, pick a platform,
name the game, and the page builds the game. Nothing is uploaded. The machine
it runs on needs no SDK, compiler, JDK or Docker. It can be a phone.

```sh
node packager/serve.js                      # http://127.0.0.1:8950/
packager/scripts/build_kits.sh              # once per engine version, on a dev machine
```

| platform | what you get | state |
|---|---|---|
| Android | a signed APK, arm64 | **works**, verified on the emulator |
| Linux | `<Name>-linux-x64.tar.gz`: unpack, run `./<id>` | **works**, verified running in a container |
| Windows | `<Name>-windows-x64.zip`: unpack, run `<Name>.exe` | **built and partly verified**; the app has not been run on real Windows (see below) |
| macOS | `<Name>-macos-arm64.zip` / `-x64.zip`: `<Name>.app`, sealed and signed ad hoc | **works**, verified on this Mac (Apple silicon); Intel server verified under Rosetta |
| iOS | | later |

## How it can need no SDK: kits

Nothing compiled into a game depends on its module:
- the server reads the module's files at run time;
- the shells read `start.txt` (Android) or `game.json` (desktop);
- the client is the same page everywhere.

So the binaries are built **once per engine version**, by the engine's own
scripts, into a **kit** per platform. A kit is a zip with `kit.json` (engine
version, ABI or Electron version, file list). The page does only what differs
per game:

- **Android:**
  - It lays the module's files beside the kit's by `build_apk.sh`'s staging
    rules. Art overrides the engine's file by file. `props.txt` and
    `animations.txt` are concatenated. The server tree gets `maps/`,
    `module.txt` and `start.txt`.
  - It renames the compiled manifest's package, label and version
    (`src/axml.js`).
  - It sets the icon (`src/arsc.js`).
  - It zips, aligned as `zipalign -p 4` would, and signs with APK Signature
    Scheme v2 (`src/apksign.js`).
- **Desktop:**
  - The game is the kit's Electron with the engine tree as `resources/app`.
    That is the place Electron runs an unpacked app from, so the shell's
    `main.js` finds `bin/`, `modules/` and `client/` beside it, as `npm start`
    does in a staged directory.
  - The page adds `build_app.sh`'s per-game half: the module under
    `modules/<id>/` (minus `.map` and `.editor.json`), plus `game.json` and
    `package.json`.
  - The executable is renamed to the game's. Electron names its user-data
    folder after `package.json`, so two games keep two sets of saves.

**A kit is not a second build.** `scripts/build_kits.sh` runs `build_apk.sh` or
`build_app.sh` on a throwaway module holding one tiny map. It removes
everything that module put in the output, and refuses the kit if the module's
name appears anywhere in what is left. The staging rules live in the engine
scripts. The page restates the per-game half in `src/android.js` and
`src/desktop.js`, which cite the sections they mirror.

### The desktop servers

`build_kits.sh` builds them in containers (`scripts/docker/`):
- **Linux:** x86-64 with clang on Ubuntu 22.04. Its glibc 2.35 runs on Ubuntu
  22.04+, Debian 12+ and Fedora 36+.
- **Windows:** x86-64 with MinGW-w64.

Both go through `engine/scripts/build_server.sh` and its one source list (see
`docs/APP.md`, "Per-platform", for the Windows port). Each target also builds
the determinism gate's golden trace and runs it, natively for Linux and under
Wine for Windows. **The kit is refused unless the trace matches this machine's
native one byte for byte.** A server that disagrees with the client's
prediction makes a game that rubber-bands, and nothing tells you why.

The Electron runtime is downloaded once per version (44.4.5, the one
`build_app.sh` resolves) and checked against the release's `SHASUMS256.txt`.

### macOS: sealed and signed in the page

On Apple Silicon every executable must be signed. A downloaded app is also
judged as a **bundle**: its main executable's signature must bind
`Info.plist` and a seal of every resource (`_CodeSignature/CodeResources`).

Electron ships linker-signed only. `codesign --verify --deep --strict` rejects
it as it comes ("code has no resources but signature indicates they must be
present"), and Gatekeeper calls such a download **damaged**, with no way past
that short of a terminal. A game also edits `Info.plist` and adds its own
files in any case. So:

- **The kit** has every nested piece signed ad hoc by the real `codesign`, on
  the Mac that builds it: the framework, the four helper apps and their
  libraries. Their cdhashes go into `kit.json`. None of that changes from game
  to game.
- **The page** handles the outer bundle:
  - it edits `Info.plist`: name, bundle id, version, the games category, and
    the integrity entry for the removed `default_app.asar` dropped;
  - it writes the seal (`src/macos.js`);
  - it signs the main executable ad hoc (`src/macho.js`).

  That is exactly what `codesign -s -` writes. Re-signing a bundle that
  `codesign` had signed gives a byte-identical CodeDirectory and the same
  cdhash, and `src/plist.js` writes `codesign`'s `CodeResources` byte for
  byte. Arm64 hashes 16 KiB pages and Intel 4 KiB: the CPU's page size.

What a player sees: the browser marks the download, so the first launch says
**"Apple could not verify…"**, and **System Settings → Privacy & Security →
Open Anyway** opens it. `spctl` gives the game the ordinary "rejected" verdict
for un-notarized code, not the integrity failure Electron as shipped gets.
Apple's `syspolicy_check` names the one gap left for clean distribution: a
**notarization ticket**, which needs an Apple Developer account.

The macOS kits are built on a Mac. The server is `build_server.sh`'s, with a
minimum of macOS 12. Intel's is built with `-arch x86_64` against a LuaJIT
built for x86-64, whose build tools run under Rosetta. Both pass the golden
trace check, the Intel one under Rosetta.

## The game's identity

- **Android package id / macOS bundle id.** By default `com.digidream.<module>`. Changing it makes
  a different app; keeping it makes an update. Games no longer overwrite each
  other as `com.digidream.app` did.
- **The signing key** (Android) is made in the page and kept in the browser
  (IndexedDB). An update must be signed with the same key, or the phone refuses
  it. So **Back up key** saves it as a file. That file holds the private key in
  the clear: keep it private.
- **The version code** (Android) must grow with every update. The page
  remembers each module's last build and starts the next one at the code plus
  one.
- **The icon** is any picture, remembered per module. Each platform derives its
  own form at build time:
  - **Android:** an adaptive-icon layer (`src/icon.js`). The picture is fitted
    into the middle 72 dp that every launcher mask leaves, and the rest is
    filled with the picture's edge colour. The APK points the kit's icon
    resources at that PNG instead of the engine's vector. That is one string in
    `resources.arsc`'s pool, since Android picks XML or bitmap by extension.
  - **Windows:** square PNGs at 16, 32, 48 and 256 px, written into the
    `.exe` (`src/pe.js`). They go into a new `.icons` section appended to the
    file, and the icon resources' entries are pointed there, so nothing
    existing moves. A signature, if the exe had one, is removed: it would no
    longer match.
  - **Linux:** `<id>.png` (512 px) beside the launcher, for a menu entry to
    name. The window's own icon is the shell's.
  - **macOS:** an `.icns` (16 to 1024 px, Retina sizes included) replacing
    Electron's. The picture fills Apple's rounded square (824 of 1024 px, as
    on Big Sur's grid), since macOS does not mask app icons.

## Two platform facts worth knowing

**The Linux sandbox.** Chromium's renderer sandbox needs either a root-owned
setuid `chrome-sandbox` or unprivileged user namespaces. An archive cannot
carry setuid-root, and Ubuntu 24.04+ (AppArmor) and containers deny the
namespaces. Electron then aborts with "The SUID sandbox helper binary was
found, but is not configured correctly", and the game never opens.

So `./<id>` is a launcher that runs `<id>.bin --no-sandbox`. If someone has run
`sudo chown root chrome-sandbox && sudo chmod 4755 chrome-sandbox`, it runs
with the sandbox instead. What `--no-sandbox` gives up is the renderer's
isolation; the renderer here loads only the game's own files from `127.0.0.1`.

**Windows file names.** A module whose files cannot exist on Windows is refused
for Windows, with examples. The names refused contain `\ : * ? " < > |`, are
`CON`, `NUL` and the like, or end in a space or dot. DOOM II is one such
module: its Arch-Vile frames are `VILE\1.png` and friends. That needs the
escaping scheme `docs/APP.md` describes, in the sprite extractor and the
client.

## Running on a phone

Only standard web APIs are used (WebCrypto, `CompressionStream`, `Blob`,
IndexedDB, `OffscreenCanvas`). On a phone:

- **Opening the module.** Android browsers have no folder picker, so a module
  arrives as a **zip**: the studio's export (`<id>/...`), or any zip of
  `modules/<id>/`.
- **Secure context.** WebCrypto needs one: https, or `127.0.0.1`.
- **Size.** The desktop kits are 130 MB (Linux) and 160 MB (Windows), mostly
  Electron. Fetching and repacking them is fine on a desktop and heavy on a
  phone.

## Tests

```sh
node packager/test/android.test.js [module]    # default: starter
node packager/test/desktop.test.js [module]
```

These run the page's code under node on a module from `modules/`.

`android.test.js` has the SDK judge the APK:
- `apksigner verify` must report v2 and our certificate;
- `zipalign -c -p 4` must pass;
- `aapt2 dump badging` must show the package, version and label;
- with an icon, `aapt2 dump resources` must show the icon as `type=PNG` and the
  vector gone.

`desktop.test.js` checks each archive:
- the launcher and the server are executable (read back with `tar`);
- the tree is where `main.js` looks;
- `game.json` and `package.json` are right;
- DOOM II is refused for Windows;
- the `.exe` keeps its four icon sizes.

It leaves the archives, and `icon-test.exe`, in `packager/build/test/` for the
smoke tests below.

```sh
node packager/test/macos.test.js [module] [--run]
```

This builds `<Name>.app`, unpacks it with `ditto` as Finder does, and has
Apple's tools judge it:
- `codesign --verify --deep --strict`;
- ad hoc, under the game's bundle id, with resources sealed and a cdhash as
  the designated requirement;
- `plutil` reads the name, id and version;
- the framework's symlinks are intact and the `.icns` is well formed;
- CONTROL: one changed byte in a resource breaks the seal.

`--run` starts the app (a window opens briefly). It requires the shell to
start the bundled server and a player to join a level, then quits the app and
checks the server went with it. Keep `ELECTRON_RUN_AS_NODE` out of its
environment: VS Code's terminals export it, and the app then runs as plain
Node, prints nothing and exits.

```sh
# a server, alive: Linux natively, Windows under Wine
docker run --rm --platform linux/amd64 -v "$PWD":/src:ro -w /src digidream-kit-test \
  node packager/test/server.smoke.mjs modules/doom2 /usr/lib/wine/wine64 packager/build/servers/windows-x64/dnp-server.exe

# the packaged Linux game, run on a virtual display, screen captured
docker run --rm --platform linux/amd64 --shm-size=512m \
  -v "$PWD/packager/build/test":/t -v "$PWD/packager/test":/smoke:ro \
  digidream-kit-desktop /smoke/desktop.smoke.sh /t/Starter-linux-x64.tar.gz /t/starter-linux.png
```

Run `build_kits.sh linux` once first, so the images exist.

```sh
cd <dir with puppeteer-core@23>
ICON=/abs/picture.png node /abs/path/packager/test/page.smoke.mjs <module.zip> <outdir>
```

This drives the page in Chrome at a phone's size: open the zip, make a key,
pick an icon, and build Android, then Linux, then Windows, fetching each
download. It needs `node packager/serve.js` running.

**What has been seen working:**
- **macOS (Apple silicon):** `starter` passes `codesign --verify --deep
  --strict`, and started both directly and with `open` it starts its server
  and joins a level. **Intel:** its server runs DOOM II under Rosetta.
- **Android:** `starter` and DOOM II install side by side with
  `com.digidream.app` and play. A game's own icon shows on the launcher and
  opens the game.
- **Linux:** `starter`, unpacked as an ordinary user, starts its server, joins
  a level and draws (`misp 0`).
- **Windows:**
  - the server runs `starter` and DOOM II under Wine;
  - its golden trace matches native;
  - `objdump` and `wrestool` read the icon-patched `.exe`.

**Windows, not yet seen:** Electron itself crashes under Wine 8 (a known
Chromium-on-Wine limitation), so **the Windows game app has not been run**.
That needs a Windows machine or VM.

## Not done

- **One module per game.** A module.txt-only add-on (`doom2fps`) cannot be
  packaged alone.
- **Maps are not baked here.** A module must carry its `.dnpm`. The studio's
  wasm `mapc` could bake them in the page.
- **Windows version info.** The `.exe`'s version strings (Explorer's
  "Properties") still say Electron. The window title and the user-data folder
  are the game's.
- **Release formats:** AAB for Google Play, and installers (MSI, AppImage,
  .deb). An APK and an unpacked folder run anywhere.
- **No code signing** for Windows (SmartScreen will warn). macOS is signed
  ad hoc but **not notarized**: a notarized build needs a Developer ID
  certificate and Apple's notary service.
