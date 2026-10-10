// A module and a desktop kit (Linux or Windows), into a game you unpack and run.
//
// The kit is engine/scripts/build_app.sh's staged tree with the module taken
// out, plus that OS's Electron and that OS's server (packager/scripts/
// build_kits.sh). A game is Electron with that tree as resources/app -- the
// place Electron runs an unpacked app from -- so the shell's main.js finds bin/,
// modules/, client/ and game.json beside it exactly as `npm start` in a staged
// directory does. What this adds back is build_app.sh's per-game half: the
// module under modules/<id>/, game.json and package.json.

import { writeZip } from './zip.js'
import { writeTarGz } from './tar.js'
import { replaceIcon } from './pe.js'

const enc = new TextEncoder()

/**
 * What every desktop game carries under resources/app -- build_app.sh's
 * per-game half, shared by Linux, Windows and macOS (macos.js).
 * Returns the number of module files added.
 */
export async function addGameTree ({ zip, mod, opts, APP, add, fromKit, platform }) {
  const id = mod.id
  // The engine's tree, without the studio unless asked.
  for (const [name, e] of zip) {
    if (!name.startsWith('app/')) continue
    if (!opts.studio && name.startsWith('app/studio/')) continue
    await fromKit(`${APP}/${name.slice(4)}`, e)
  }
  // The module, whole except the authoring sources (build_app.sh:
  // cp -R, then find maps -name '*.map' -o -name '*.editor.json' -delete).
  let n = 0
  for (const [p, f] of mod.files) {
    if (/^maps\/(.*\/)?[^/]*(\.map|\.editor\.json)$/.test(p)) continue
    add(`${APP}/modules/${id}/${p}`, await f.read()); n++
  }
  // What this game IS (build_app.sh "what this app IS"), and the package
  // Electron reads -- its name is also the user-data folder, so two games
  // keep two sets of saves.
  // The map it starts on: the one chosen, else the module's first, as the
  // Android and Tauri builds do (the shell passes it first, then the rest).
  const map = opts.map && mod.maps.includes(opts.map) ? opts.map : mod.maps[0]
  add(`${APP}/game.json`, enc.encode(JSON.stringify({
    name: opts.label,
    id,
    modules: [id],
    ...(map ? { map } : {}),
    studio: !!opts.studio,
    builtAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    platform
  }, null, 2) + '\n'))
  add(`${APP}/package.json`, enc.encode(JSON.stringify({
    name: id.toLowerCase(),
    productName: opts.label,
    version: opts.version || '1.0.0',
    private: true,
    type: 'module',
    main: 'app/main.js'
  }, null, 2) + '\n'))
  return n
}

// THE LINUX SANDBOX. Chromium's renderer sandbox needs either a root-owned
// setuid chrome-sandbox or unprivileged user namespaces. A downloaded archive
// cannot carry setuid-root, and Ubuntu 24.04+ (AppArmor) and containers deny
// the namespaces -- so Electron aborts with "The SUID sandbox helper binary was
// found, but is not configured correctly" and the game never opens. Found by
// running a packaged game in a container (packager/test/desktop.smoke.mjs).
//
// So the game's name is this launcher, which runs the real binary with
// --no-sandbox -- unless somebody has made chrome-sandbox setuid root (sudo
// chown root chrome-sandbox && sudo chmod 4755 chrome-sandbox), in which case
// the sandbox works and is used. What --no-sandbox gives up is the renderer's
// isolation; the renderer here loads only the game's own files from 127.0.0.1.
function linuxLauncher (binary) {
  return `#!/bin/sh
# Starts the game. See the packager's README ("The Linux sandbox").
here="$(dirname "$(readlink -f "$0")")"
sandbox="$here/chrome-sandbox"
if [ -u "$sandbox" ] && [ "$(stat -c %u "$sandbox" 2>/dev/null)" = "0" ]; then
  exec "$here/${binary}" "$@"
fi
exec "$here/${binary}" --no-sandbox "$@"
`
}

// Names Windows will not create a file or folder under.
const WIN_BAD = /[\\:*?"<>|\u0000-\u001f]/
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Module paths a Windows filesystem cannot hold, or []. */
export function windowsPathProblems (mod) {
  const bad = []
  for (const p of mod.files.keys()) {
    const segs = p.split('/')
    if (segs.some((s) => WIN_BAD.test(s) || WIN_RESERVED.test(s) || /[ .]$/.test(s))) bad.push(p)
  }
  return bad
}

/** A folder name for the game: its label, minus what a filesystem refuses. */
export function folderName (label, id) {
  const s = label.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[ .]+$/, '')
  return s && !WIN_RESERVED.test(s) ? s : id
}

/** The executable's file name: lower-case id on Linux, "<Label>.exe" on Windows. */
export function executableName (kit, label, id) {
  return kit === 'windows' ? `${folderName(label, id)}.exe` : id.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
}

/**
 * opts: { label, version, studio, iconFor? }
 *   iconFor(size) -> PNG bytes of a square icon (icon.js makes them). Windows:
 *   written into the .exe (pe.js). Linux: <exe>.png beside the launcher, 512 px,
 *   for a menu entry to name.
 * Returns { blob, filename }.
 */
export async function buildDesktop (kit, mod, opts, log = () => {}) {
  const { info, zip } = kit
  const id = mod.id
  const dir = folderName(opts.label, id)
  const exe = executableName(info.kit, opts.label, id)
  const APP = `${dir}/resources/app`

  if (info.kit === 'windows') {
    const bad = windowsPathProblems(mod)
    if (bad.length) {
      throw new Error(`${bad.length} file name(s) in this module cannot exist on Windows, e.g. ${bad.slice(0, 3).join(', ')}`)
    }
  }

  // name -> entry; Windows output copies the kit's compressed bytes as they are.
  const out = new Map()
  const fromKit = async (name, e) => {
    if (info.kit === 'windows') out.set(name, { name, raw: { method: e.method, crc: e.crc, size: e.size, data: e.raw } })
    else out.set(name, { name, data: await e.bytes(), mode: e.mode ?? 0o644 })
  }
  const add = (name, data, mode = 0o644) => out.set(name, { name, data, mode, compress: true })

  // 1. The runtime, the executable renamed to the game's. On Linux the
  //    binary becomes <exe>.bin and <exe> is a launcher (see LINUX_LAUNCHER).
  const binary = info.kit === 'linux' ? `${exe}.bin` : exe
  for (const [name, e] of zip) {
    if (!name.startsWith('runtime/')) continue
    const rel = name.slice('runtime/'.length)
    if (rel === info.exe && info.kit === 'windows' && opts.iconFor) {
      const { bytes, sizes } = await replaceIcon(await e.bytes(), opts.iconFor)
      add(`${dir}/${binary}`, bytes)
      log(`icon: written into ${binary} at ${sizes.join(', ')} px`)
      continue
    }
    await fromKit(`${dir}/${rel === info.exe ? binary : rel}`, e)
  }
  if (info.kit === 'linux') add(`${dir}/${exe}`, enc.encode(linuxLauncher(binary)), 0o755)
  // 2-4. The engine's tree, the module, game.json and package.json.
  // opts.tree replaces the game tree: the packager's own desktop app is built
  // by this same code with its own files in resources/app (scripts/build_apps.mjs).
  const n = await (opts.tree ?? addGameTree)({ zip, mod, opts, APP, add, fromKit, platform: info.kit === 'windows' ? 'Windows-x86_64' : 'Linux-x86_64' })
  if (opts.iconFor && info.kit === 'linux') add(`${dir}/${exe}.png`, await opts.iconFor(512))

  log(`module ${id}: ${n} file(s), ${mod.maps.length} level(s); ${info.kit} x64, Electron ${info.electron}`)
  log(`${dir}/${exe}`)
  const entries = [...out.values()]
  if (info.kit === 'windows') {
    log(`zipping ${entries.length} entries`)
    const bytes = await writeZip(entries)
    return { blob: new Blob([bytes], { type: 'application/zip' }), filename: `${dir}-windows-x64.zip` }
  }
  log(`packing ${entries.length} entries (tar.gz, so the executables stay executable)`)
  const blob = await writeTarGz(entries)
  return { blob, filename: `${dir}-linux-x64.tar.gz` }
}
