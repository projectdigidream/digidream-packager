// Builds the STUDIO as a desktop app -- Linux, Windows, macOS -- from the
// packager's desktop kits, with the packager's own builders.
//
//   node packager/scripts/build_studio.mjs                  # every desktop kit present
//   node packager/scripts/build_studio.mjs linux macos-arm64
//
// A studio build IS a packager build: the starter module with the studio
// switched on (the kits carry the studio's pages; a game build leaves them
// out). So the studio people run and the games they package come from the
// same kits, and building the kits again (build_kits.sh) is what puts today's
// studio and engine in both. scripts/release_studio.sh runs the whole round.
//
// Two things a game build would get wrong for the studio:
//   - the app's data folder: Electron names it after package.json's name,
//     which for a game is the module's id -- a studio built on `starter`
//     would share its saved work with a game called starter. It is
//     `digidream-studio`, the bundle id com.digidream.studio.
//   - the Package page: the studio's packager plugin looks for its kits under
//     studio/packager-kits/, and the kits themselves are built without them
//     (a kit must not carry kits). The small ones -- Android and the Tauri
//     desktops, ~24 MB -- go in, as build_app.sh does for a studio build.
//
// The Android studio is engine/scripts/build_apk.sh --studio: the same debug
// key and package id as every studio APK before, so a phone updates in place
// and keeps its modules (a packager-signed APK would be a different app).
//
// Output: builds/Digidream Studio-<platform>.{tar.gz,zip}, at the repository's root.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readKit } from '../src/kit.js'
import { buildDesktop, addGameTree } from '../src/desktop.js'
import { buildMac } from '../src/macos.js'
import { moduleFromEntries } from '../src/module.js'
import { square } from '../../branding/icons.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const REPO = join(PKG, '..')
const KITS = join(PKG, 'build', 'kits')
const OUT = join(REPO, 'builds')
mkdirSync(OUT, { recursive: true })

const LABEL = 'Digidream Studio'
const NAME = 'digidream-studio'
const BUNDLE_ID = 'com.digidream.studio'
const VERSION = readFileSync(join(REPO, 'studio', 'VERSION'), 'utf8').trim()
const ENGINE = readFileSync(join(REPO, 'engine', 'VERSION'), 'utf8').trim()
const SMALL_KITS = ['android', 'tauri-macos-arm64', 'tauri-macos-x64', 'tauri-linux', 'tauri-windows']
const enc = new TextEncoder()

// --no-plugins: the studio without its bundled plugins -- an empty plugin
// index, and none of the packager's kits (only its plugin uses them).
const NO_PLUGINS = process.argv.includes('--no-plugins')
const want = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const all = ['linux', 'windows', 'macos-arm64', 'macos-x64']
const targets = (want.length ? want : all).filter((t) => {
  if (existsSync(join(KITS, `${t}.zip`))) return true
  console.log(`[studio] no ${t} kit in packager/build/kits -- skipped`)
  return false
})
if (!targets.length) { console.error('[studio] no desktop kits -- run packager/scripts/build_kits.sh'); process.exit(2) }

// The starter module, as the studio ships it.
function walk (dir) {
  const out = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (n === '.DS_Store') continue
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p)
  }
  return out
}
const mod = await moduleFromEntries(walk(join(REPO, 'modules', 'starter')).map((p) => ({
  path: relative(join(REPO, 'modules'), p), size: statSync(p).size, read: async () => new Uint8Array(readFileSync(p))
})))

// The small kits, from the same engine version as the desktop kit they go
// into: a studio whose Package page builds with an older engine than it runs
// is a studio that makes games it cannot play.
const smallKits = []
for (const k of NO_PLUGINS ? [] : SMALL_KITS) {
  const f = join(KITS, `${k}.zip`)
  if (!existsSync(f)) { console.log(`[studio] no ${k} kit: the Package page will not have it`); continue }
  smallKits.push({ k, bytes: new Uint8Array(readFileSync(f)), engine: (await readKit(new Uint8Array(readFileSync(f)))).info.engine })
}

// The game tree, with the studio's own name and its packager's kits.
const tree = (engine) => async (ctx) => {
  const add = (p, data, mode) => {
    if (NO_PLUGINS && p.startsWith(`${ctx.APP}/studio/plugins/`)) return
    if (p === `${ctx.APP}/package.json`) {
      const pj = JSON.parse(new TextDecoder().decode(data))
      data = enc.encode(JSON.stringify({ ...pj, name: NAME, productName: LABEL, version: VERSION }, null, 2) + '\n')
    }
    return mode === undefined ? ctx.add(p, data) : ctx.add(p, data, mode)
  }
  // THE STUDIO'S PAGES COME FROM THE STUDIO, not the kit. A kit holds the
  // studio as it was when the kit was built, so a studio released on kits made
  // earlier (--kits-from: 0.3.4.1 and 0.3.4.2 on the 0.1.5 kits) shipped the
  // older studio's pages on the desktop while its APK had the new ones. From the
  // kit only what the engine makes: the map compiler (wasm/), the runtime Lua
  // (runtime/), the packager's kits.
  const STUDIO = `${ctx.APP}/studio/`
  const ownPaths = (p) => p.startsWith(STUDIO) && /^(index\.html|sw\.js|VERSION|src\/|vendor\/|plugins\/)/.test(p.slice(STUDIO.length))
  const fromKit = (p, e) => (ownPaths(p) ? undefined : ctx.fromKit(p, e))
  const n = await addGameTree({ ...ctx, add, fromKit })
  const studio = join(REPO, 'studio')
  for (const f of ['index.html', 'sw.js', 'VERSION']) add(`${STUDIO}${f}`, new Uint8Array(readFileSync(join(studio, f))))
  for (const d of NO_PLUGINS ? ['src', 'vendor'] : ['src', 'vendor', 'plugins']) {
    for (const f of walk(join(studio, d))) add(`${STUDIO}${relative(studio, f)}`, new Uint8Array(readFileSync(f)))
  }
  if (NO_PLUGINS) ctx.add(`${STUDIO}plugins/index.json`, enc.encode('{ "plugins": [] }\n'))
  let k = 0
  for (const s of smallKits) {
    if (s.engine !== engine) { console.log(`        NOT bundling ${s.k}: engine ${s.engine}, this kit is ${engine}`); continue }
    add(`${ctx.APP}/studio/packager-kits/${s.k}.zip`, s.bytes); k++
  }
  console.log(`        ${k} packager kit(s) inside`)
  return n
}

let failed = 0
for (const t of targets) {
  const kit = await readKit(new Uint8Array(readFileSync(join(KITS, `${t}.zip`))))
  if (kit.info.engine !== ENGINE) console.log(`[studio] ${t}: WARNING the kit is engine ${kit.info.engine}, engine/VERSION says ${ENGINE} -- rebuild the kits`)
  const log = (l) => console.log(`        ${l}`)
  console.log(`[studio] ${t}  (kit: engine ${kit.info.engine}, Electron ${kit.info.electron})`)
  try {
    // The Digidream logo (branding/icons.mjs): the exe's icon, the .icns, the Linux png.
    const opts = { label: LABEL, version: VERSION, studio: true, tree: tree(kit.info.engine), iconFor: async (n) => square(n) }
    const { blob, filename } = kit.info.kit === 'macos'
      ? await buildMac(kit, mod, { ...opts, bundleId: BUNDLE_ID }, log)
      : await buildDesktop(kit, mod, opts, log)
    const out = join(OUT, NO_PLUGINS ? filename.replace(LABEL, `${LABEL} (no plugins)`) : filename)
    writeFileSync(out, new Uint8Array(await blob.arrayBuffer()))
    console.log(`[studio] ${t}  ${relative(REPO, out)}  (${(blob.size / 1048576).toFixed(0)} MB)`)
  } catch (e) {
    failed++
    console.error(`[studio] ${t}  FAILED: ${e.message}`)
  }
}
process.exit(failed ? 1 : 0)
