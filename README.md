# Packager

A module in, a game out, in a browser page. Pick a module, pick a platform,
name the game, and the page builds and signs it. Nothing is uploaded. The machine it runs on
needs no SDK, compiler or JDK. It can be a phone.

```sh
node packager/serve.js                  # http://127.0.0.1:8950/
packager/scripts/build_kits.sh android  # once per engine version, on a dev machine
```

| platform | state |
|---|---|
| Android | **works**: an APK, arm64, signed (APK Signature Scheme v2) |
| Linux | needs its kit |
| Windows | needs the server ported (`__int128`, POSIX sockets, `\` in doom2 sprite names), then its kit |
| macOS | last |
| iOS | later |

## How it can need no SDK: kits

Nothing compiled into a game depends on its module. The server reads the
module's files at run time. The Java shell reads `start.txt`, and the client is
the same page everywhere. So the binaries are built **once per engine version**,
by the engine's own scripts, into a **kit**: a zip with `kit.json` (engine
version, ABI, file list).

The page does only what genuinely differs per game:

1. it lays the module's files beside the kit's, by the staging rules of
   `engine/scripts/build_apk.sh`:
   - art overrides the engine's file by file;
   - `props.txt` and `animations.txt` are concatenated;
   - the server tree gets `maps/`, `module.txt` and `start.txt`;
2. it writes the manifest fields that name the game (`src/axml.js` decodes the kit's compiled
   `AndroidManifest.xml`, changes package, label and version, and encodes it
   again);
3. it zips, aligned as `zipalign -p 4` would, and signs (`src/apksign.js`).

**A kit is not a second build.** `scripts/build_kits.sh` runs `build_apk.sh` on
a throwaway module that holds one tiny map. It then removes everything that
module put in the APK, and refuses the kit if the module's name appears
anywhere in what is left. So the staging rules live in the engine script. The
page restates the module half of them in `src/android.js`, which cites the
script's sections.

## The package id is the game's identity

Every module used to become `com.digidream.app`, so installing one game
replaced the other. Here each game gets its own id (by default
`com.digidream.<module>`). Changing the id makes a different app, and keeping
it makes an update.

**The signing key.** The key is made in the page and kept in the browser
(IndexedDB). An update must be signed with the same key, or the phone refuses
it. So **Back up key** saves it as a file. That file holds the private key in
the clear: keep it private.

**The version code** must grow with every update. The page remembers each
module's last build and starts the next one at the code plus one.

## Running on a phone

Only standard web APIs are used (WebCrypto, `CompressionStream`, `Blob`,
IndexedDB). On a phone:

- **Opening the module.** Android browsers have no folder picker, so a module
  arrives as a **zip**: the studio's export (`<id>/...`), or any zip of
  `modules/<id>/`.
- **Secure context.** WebCrypto needs one: https, or `127.0.0.1`. A LAN address
  over plain http does not work, so serve the tool over https to reach it from
  another device.

## Tests

```sh
node packager/test/android.test.js [module]   # default: starter
```

This runs the page's code under node on a module from `modules/`. Then the SDK
judges the result:
- `apksigner verify` must report v2 and our certificate;
- `zipalign -c -p 4` must pass;
- `aapt2 dump badging` must show the package, version and label.

It also checks:
- that the manifest's other lines did not move;
- that the zip path a phone uses sees the same module;
- the staged trees.

It skips without an SDK or a kit.

```sh
cd <dir with puppeteer-core@23>
node /abs/path/packager/test/page.smoke.mjs <module.zip> <outdir>
```

This drives the page in Chrome at a phone's size: open the zip, make a key,
build, and fetch the download. It needs `node packager/serve.js` running.

Verified on the Android emulator: `starter` and DOOM II install side by side
with `com.digidream.app` and play (`docs/screenshots/2026-10-06-packager-*`).

## Not done

- **A module.txt-only add-on** (`doom2fps`) cannot be packaged: one module per
  game, as `build_apk.sh` takes. Several modules per game come next.
- **The icon** is the kit's (`res/`). A per-game icon means writing the
  resource table, not only the manifest.
- **Maps are not baked here.** A module must carry its `.dnpm`. The studio's
  wasm `mapc` could bake them in the page.
- **Release AAB** for Google Play: not yet. An APK installs anywhere.
