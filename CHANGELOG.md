# Changelog

What changed in each release of the packager, fixes first. Kept as fixes
land: anything not released yet is under **Unreleased**.

## Unreleased

## 0.1.1 -- 2026-10-15

Ships with engine 0.1.2's Android and Tauri kits.

### Fixed

- **Games built for Android had no music or sound effects**: the kits it
  shipped with lacked the audio engines (engine 0.1.2). `build_kits.sh` now
  refuses a kit without them.
- **Every platform just said "no kit"**, with nothing saying where kits come
  from. A missing kit now has a **Download** button (the latest engine
  release's kit, with its size); the desktop app downloads it itself, a
  browser starts a normal download to load with **Load a kit file**.

### Changed

- A README for users (download, when the studio's Package page is enough,
  how to use it, where kits come from); the internals moved to DEVELOPING.md.

## 0.1.0 -- 2026-10-14

The first public release.
