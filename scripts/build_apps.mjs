// Builds the packager ITSELF as a desktop app -- Windows, Linux, macOS -- with
// the packager's own builders, from the desktop kits' Electron runtimes.
//
//   node packager/scripts/build_apps.mjs                 # every desktop kit present
//   node packager/scripts/build_apps.mjs linux macos-arm64
//
// What goes in resources/app instead of a game: shells/desktop (main.cjs,
// preload.cjs), the page under www/ (index.html, src/), and the Android kit
// under www/kits/ -- 14 MB, so a fresh install can build an Android game at
// once. The desktop kits are 130-165 MB each and are not bundled: the app keeps
// the ones it is given (Load a kit file) in its kit store.
//
// Output: packager/build/apps/Digidream Packager-<platform>.{tar.gz,zip}. The
// Android app is scripts/build_app_android.sh (it needs the SDK, not a kit).

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readKit } from '../src/kit.js'
import { buildDesktop } from '../src/desktop.js'
import { buildMac } from '../src/macos.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const KITS = join(PKG, 'build', 'kits')
const OUT = join(PKG, 'build', 'apps')
mkdirSync(OUT, { recursive: true })

const VERSION = readFileSync(join(PKG, 'VERSION'), 'utf8').trim()
const LABEL = 'Digidream Packager'
const enc = new TextEncoder()

const want = process.argv.slice(2)
const all = ['linux', 'windows', 'macos-arm64', 'macos-x64']
const targets = (want.length ? want : all).filter((t) => existsSync(join(KITS, `${t}.zip`)))
if (!targets.length) { console.error('[apps] no desktop kits in packager/build/kits -- run scripts/build_kits.sh'); process.exit(2) }

const file = (p) => new Uint8Array(readFileSync(p))
const icon = async (n) => {
  const sizes = [16, 32, 48, 64, 128, 256, 512, 1024]
  const s = sizes.find((x) => x >= n) ?? 1024
  return file(join(PKG, 'shells', 'icon', `icon-${s}.png`))
}

// The packager's resources/app.
async function tree ({ APP, add }) {
  add(`${APP}/main.cjs`, file(join(PKG, 'shells', 'desktop', 'main.cjs')))
  add(`${APP}/preload.cjs`, file(join(PKG, 'shells', 'desktop', 'preload.cjs')))
  add(`${APP}/package.json`, enc.encode(JSON.stringify({
    name: 'digidream-packager', productName: LABEL, version: VERSION, private: true, main: 'main.cjs'
  }, null, 2) + '\n'))
  add(`${APP}/www/index.html`, file(join(PKG, 'index.html')))
  let n = 3
  for (const f of readdirSync(join(PKG, 'src'))) {
    if (f.endsWith('.js')) { add(`${APP}/www/src/${f}`, file(join(PKG, 'src', f))); n++ }
  }
  if (existsSync(join(KITS, 'android.zip'))) { add(`${APP}/www/kits/android.zip`, file(join(KITS, 'android.zip'))); n++ }
  return n
}

// The builders take a module; the packager is not one, so it is an empty one
// that names the app.
const self = { id: 'digidream-packager', name: LABEL, files: new Map(), maps: [], bytes: 0 }

for (const t of targets) {
  const kit = await readKit(file(join(KITS, `${t}.zip`)))
  const log = (l) => console.log(`        ${l}`)
  console.log(`[apps] ${t}  (kit: engine ${kit.info.engine}, Electron ${kit.info.electron})`)
  const opts = { label: LABEL, version: VERSION, studio: false, iconFor: icon, tree }
  const { blob, filename } = kit.info.kit === 'macos'
    ? await buildMac(kit, self, { ...opts, bundleId: 'com.digidream.packager' }, log)
    : await buildDesktop(kit, self, opts, log)
  const out = join(OUT, filename)
  writeFileSync(out, new Uint8Array(await blob.arrayBuffer()))
  console.log(`[apps] ${t}  ${out}  (${(blob.size / 1048576).toFixed(0)} MB)`)
}
