# Changelog

What changed in each release of the packager, fixes first. Kept as fixes
land: anything not released yet is under **Unreleased**.

## Unreleased

### Fixed

- **A kit the app already carried was offered as a download**: the platform
  box was drawn before the kits were looked for, waited on the engine's
  releases, and, finishing last, put back the button the later draw had
  cleared. In the Android studio that button then left the app for GitHub.
  The newest draw now wins.
- **The steps were numbered 1, 2, 3, 5** off Android, where "Signing key" is
  hidden: they are numbered as shown.
- **A macOS build's log said "fetching the android kit"** with no reason: it
  says the game's pages in every Tauri build come from that kit.

- **The studio's desktop builds carried the studio of their kits**:
  `build_studio.mjs` took the studio's pages from the engine kit, which holds
  the studio as it was when the kit was built, so studio 0.3.4.1 and 0.3.4.2,
  released on the 0.1.5 kits, were 0.3.4 on Windows, Linux and macOS (their
  APKs were right). The pages now come from the studio itself; the kit gives
  only what the engine makes (the map compiler, the runtime Lua).

## 0.1.2 -- 2026-10-15

Ships with engine 0.1.3's Android and Tauri kits.

### Changed

- The map choice starts on the module's starting map when the studio's
  Settings name one (else the last build's choice, else the first by name).

## 0.1.1 -- 2026-10-15

Ships with engine 0.1.2's Android and Tauri kits, so games built with it
get the engine's 0.1.2 fixes: weapon swings set as fractions are predicted
(their first-person animations play), and phones in first person no longer
ask for a pointer lock.

## 0.1.0 -- 2026-10-14

The first public release. Rebuilt on 2026-10-15 (same version) with the
fixes below.

### Fixed

- **Games built for Android had no music or sound effects**: the kits it
  shipped with lacked the synth (`dist/midisynth.mjs`, which the music
  worklet imports) and the sound engine (`dsound.mjs`). `build_kits.sh` now
  refuses to build a kit without them, and checks each kit's zip for both.
- **Every platform just said "no kit"**, with nothing saying where kits come
  from. A missing kit now has a **Download** button (the latest engine
  release's kit, with its size); the desktop app downloads it itself, a
  browser starts a normal download to load with **Load a kit file**.

### Changed

- A README for users (download, when the studio's Package page is enough,
  how to use it, where kits come from); the internals moved to DEVELOPING.md.
