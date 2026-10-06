// A module and a TAURI kit, into a desktop game that runs in the operating
// system's own web view -- the option beside the Electron builds (desktop.js,
// macos.js), which stay the default.
//
// A Tauri kit is small: the runner for one OS (shells/tauri, a few MB) and the
// server for it. Everything else comes from the ANDROID kit, whose staged web
// tree and server tree are exactly what the runner serves -- built by
// android.js's stageTrees with the same rules, the engine's shared shell.js
// included, with the runner's three-line shim (tauri-native.js) in front of it.
// So the two kits must come from the same engine version, and that is checked.
//
//   <Name>/<exe> + <Name>/game/                Linux (.tar.gz) and Windows (.zip)
//   <Name>.app/Contents/{MacOS,Resources/game}  macOS (.zip), sealed and signed
//                                               ad hoc like the Electron build
//
// Game only: the studio's file calls exist in the Electron, Android and iOS
// shells, not (yet) in the runner.

import { writeZip } from './zip.js'
import { writeTarGz } from './tar.js'
import { stageTrees } from './android.js'
import { folderName, executableName, windowsPathProblems } from './desktop.js'
import { replaceIcon } from './pe.js'
import { makeIcns } from './icns.js'
import { writePlist } from './plist.js'
import { codeResources } from './macos.js'
import { signMain } from './macho.js'

const enc = new TextEncoder()
const t = (k, v) => [k, v]

/** The kit-store name of a Tauri kit: tauri-linux, tauri-windows, tauri-macos-arm64. */
export const tauriKitName = (info) => `tauri-${info.os}${info.os === 'macos' ? `-${info.arch}` : ''}`

/**
 * opts: { label, version, bundleId (macOS), map?, iconFor? }
 * Returns { blob, filename }.
 */
export async function buildTauri (tauriKit, androidKit, mod, opts, log = () => {}) {
  const { info, zip } = tauriKit
  if (info.engine !== androidKit.info.engine) {
    throw new Error(`the Tauri kit is engine ${info.engine} and the Android kit is ${androidKit.info.engine}: they must match`)
  }
  const os = info.os
  if (os === 'windows') {
    const bad = windowsPathProblems(mod)
    if (bad.length) throw new Error(`${bad.length} file name(s) in this module cannot exist on Windows, e.g. ${bad.slice(0, 3).join(', ')}`)
  }
  const dir = folderName(opts.label, mod.id)
  const exe = os === 'windows' ? executableName('windows', opts.label, mod.id) : executableName('linux', opts.label, mod.id)
  const ROOT = os === 'macos' ? `${dir}.app/Contents` : dir
  const GAME = os === 'macos' ? `${ROOT}/Resources/game` : `${ROOT}/game`
  const map = opts.map || mod.maps[0]

  const out = new Map()
  const add = (path, data, mode = 0o100644) => out.set(path, { name: path, data, mode, compress: true })
  // A kit file takes its place in `out` AT ONCE and is inflated afterwards:
  // the module's own art, put later at the same path, must replace it, and an
  // asynchronous copy could land after that and silently undo it. A Windows zip
  // keeps the kit's compressed bytes; a sealed bundle and a tar need them.
  const copyKit = (path, e) => {
    if (os === 'windows') out.set(path, { name: path, raw: { method: e.method, crc: e.crc, size: e.size, data: e.raw }, mode: e.mode ?? 0o100644 })
    else out.set(path, { name: path, lazy: e, mode: e.mode && (e.mode & 0o111) ? 0o100755 : 0o100644, compress: true })
  }
  const to = (n) => n.replace(/^assets\/web\//, `${GAME}/web/`).replace(/^assets\/game\//, `${GAME}/game/`)
  const { art, gameFiles } = await stageTrees(androidKit.zip, mod, { ...opts, map, studio: false },
    (path, data) => add(path, data), copyKit, to)
  for (const e of out.values()) if (e.lazy) { e.data = await e.lazy.bytes(); delete e.lazy }

  // shell.js: the runner's shim, then the engine's shared shell.
  const shim = await zip.get(info.shim).bytes()
  const shell = await androidKit.zip.get('assets/web/shell.js').bytes()
  // Joined with a SEMICOLON: both are IIFEs, and `})()` then a newline then
  // `(function` is ONE expression in JavaScript -- the shim's result called
  // with the shell as its argument. The shim ran, the shell never did, and the
  // client, finding no window.dnp, went solo and rejected a map it fetched.
  add(`${GAME}/web/shell.js`, new Uint8Array([...shim, ...enc.encode(';\n'), ...shell]))
  add(`${GAME}/game.json`, enc.encode(JSON.stringify({ name: opts.label, id: mod.id, module: mod.id, map }, null, 2) + '\n'))
  const serverName = info.server.split('/').pop()
  add(`${GAME}/bin/${serverName}`, await zip.get(info.server).bytes(), 0o100755)
  log(`module ${mod.id}: ${mod.maps.length} level(s), starting on ${map}; ${art} art file(s), ${gameFiles} server file(s); Tauri runner for ${os} ${info.arch}`)

  let runner = await zip.get(info.runner).bytes()
  if (os === 'windows') {
    if (opts.iconFor) {
      runner = (await replaceIcon(runner, opts.iconFor)).bytes
      log(`icon: written into ${exe}`)
    }
    add(`${ROOT}/${exe}`, runner, 0o100755)
    const entries = [...out.values()]
    log(`zipping ${entries.length} entries`)
    return { blob: new Blob([await writeZip(entries)], { type: 'application/zip' }), filename: `${dir}-windows-x64-tauri.zip` }
  }
  if (os === 'linux') {
    add(`${ROOT}/${exe}`, runner, 0o100755)
    if (opts.iconFor) add(`${ROOT}/${exe}.png`, await opts.iconFor(512))
    const entries = [...out.values()]
    log(`packing ${entries.length} entries (tar.gz)`)
    return { blob: await writeTarGz(entries), filename: `${dir}-linux-x64-tauri.tar.gz` }
  }

  // macOS: Info.plist written here (the runner has none of its own), the icon,
  // then the seal over Resources and the ad-hoc signature that binds both.
  const icns = opts.iconFor ? await makeIcns(opts.iconFor) : await zip.get(info.icon).bytes()
  add(`${ROOT}/Resources/icon.icns`, icns)
  const infoPlist = writePlist(new Map([
    t('CFBundleDevelopmentRegion', 'en'),
    t('CFBundleDisplayName', opts.label),
    t('CFBundleExecutable', exe),
    t('CFBundleIconFile', 'icon.icns'),
    t('CFBundleIdentifier', opts.bundleId),
    t('CFBundleInfoDictionaryVersion', '6.0'),
    t('CFBundleName', opts.label.slice(0, 15)),
    t('CFBundlePackageType', 'APPL'),
    t('CFBundleShortVersionString', opts.version || '1.0'),
    t('CFBundleVersion', opts.version || '1.0'),
    t('LSApplicationCategoryType', 'public.app-category.games'),
    t('LSMinimumSystemVersion', '12.0'),
    t('NSHighResolutionCapable', true)
  ]))
  out.set(`${ROOT}/Info.plist`, { name: `${ROOT}/Info.plist`, data: infoPlist, mode: 0o100644, compress: true })
  const resources = [...out.values()]
    .filter((e) => e.name.startsWith(`${ROOT}/Resources/`))
    .map((e) => ({ path: e.name.slice(ROOT.length + 1), data: e.data }))
  log(`sealing ${resources.length} resource file(s)`)
  const seal = await codeResources(resources, [])
  out.set(`${ROOT}/_CodeSignature/CodeResources`, { name: `${ROOT}/_CodeSignature/CodeResources`, data: seal, mode: 0o100644, compress: true })
  const { bytes } = await signMain(runner, opts.bundleId, { infoPlist, codeResources: seal })
  out.set(`${ROOT}/MacOS/${exe}`, { name: `${ROOT}/MacOS/${exe}`, data: bytes, mode: 0o100755, compress: true })
  log(`signed ad hoc: ${opts.bundleId}`)
  const entries = [...out.values()]
  log(`zipping ${entries.length} entries`)
  return { blob: new Blob([await writeZip(entries)], { type: 'application/zip' }), filename: `${dir}-macos-${info.arch}-tauri.zip` }
}
