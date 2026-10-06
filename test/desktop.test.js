// The desktop path: a module and the Linux / Windows kit, into a game.
//
//   node packager/test/desktop.test.js [module]      (default: starter)
//
// Runs the page's code under node and checks the archive it hands over: the
// launcher renamed and executable, the server executable, the engine tree and
// the module where the shell's main.js looks for them, game.json and
// package.json as build_app.sh writes them. Leaves
//   packager/build/test/<Name>-linux-x64.tar.gz
//   packager/build/test/<Name>-windows-x64.zip
// for desktop.smoke.mjs, which RUNS the Linux one. Skips a kit that is absent.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readKit } from '../src/kit.js'
import { buildDesktop, windowsPathProblems, folderName, executableName } from '../src/desktop.js'
import { moduleFromEntries } from '../src/module.js'
import { readZip } from '../src/zip.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const REPO = join(PKG, '..')
const MODULE = process.argv[2] ?? 'starter'
const OUT = join(PKG, 'build', 'test')
mkdirSync(OUT, { recursive: true })

let checks = 0
let fails = 0
const check = (ok, what) => { checks++; if (!ok) { fails++; console.log(`  FAIL ${what}`) } }

function walk (dir) {
  const out = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p)
  }
  return out
}
const moduleFromDisk = (dir) => moduleFromEntries(walk(dir).map((p) => ({
  path: relative(dirname(dir), p), size: statSync(p).size, read: async () => new Uint8Array(readFileSync(p))
})))

console.log('desktop: names')
check(folderName('DOOM II', 'doom2') === 'DOOM II', 'a label is the folder')
check(folderName('a/b:c?', 'x') === 'a b c', 'what a filesystem refuses is dropped')
check(folderName('CON', 'x') === 'x', 'a reserved Windows name falls back to the id')
check(executableName('windows', 'DOOM II', 'doom2') === 'DOOM II.exe', 'Windows: <Label>.exe')
check(executableName('linux', 'DOOM II', 'doom2') === 'doom2', 'Linux: the id')
const doom2 = await moduleFromDisk(join(REPO, 'modules', 'doom2'))
const bad = windowsPathProblems(doom2)
check(bad.some((p) => p.includes('VILE\\')), `doom2's VILE\\1 sprites are named as impossible on Windows (${bad.length})`)

const mod = await moduleFromDisk(join(REPO, 'modules', MODULE))
const opts = { label: mod.name, version: '1.0.0', studio: false }
const dir = folderName(mod.name, mod.id)

for (const k of ['linux', 'windows']) {
  const kitPath = join(PKG, 'build', 'kits', `${k}.zip`)
  if (!existsSync(kitPath)) { console.log(`desktop: no ${k} kit; skipped`); continue }
  console.log(`desktop: ${k}, ${MODULE}`)
  const kit = await readKit(readFileSync(kitPath), k)
  const t0 = Date.now()
  const { blob, filename } = await buildDesktop(kit, mod, opts, (l) => console.log(`       ${l}`))
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const file = join(OUT, filename)
  writeFileSync(file, bytes)
  console.log(`       ${(bytes.length / 1048576).toFixed(1)} MB in ${Date.now() - t0} ms -> ${relative(REPO, file)}`)

  const APP = `${dir}/resources/app`
  let names, modes
  if (k === 'linux') {
    const r = spawnSync('tar', ['-tzvf', file], { encoding: 'utf8', maxBuffer: 1 << 28 })
    check(r.status === 0, `tar reads it: ${r.stderr}`)
    const lines = r.stdout.trim().split('\n')
    names = new Set(lines.map((l) => l.split(/\s+/).slice(8).join(' ')))
    modes = new Map(lines.map((l) => [l.split(/\s+/).slice(8).join(' '), l.split(/\s+/)[0]]))
    check(modes.get(`${dir}/${mod.id}`)?.startsWith('-rwx'), `the launcher ${dir}/${mod.id} is executable (${modes.get(`${dir}/${mod.id}`)})`)
    check(modes.get(`${APP}/bin/dnp-server`)?.startsWith('-rwx'), 'the server is executable')
    check(modes.get(`${dir}/${mod.id}.bin`)?.startsWith('-rwx'), 'the binary beside it is executable')
    check(!names.has(`${dir}/electron`), 'Electron\'s own name is gone')
  } else {
    const z = readZip(bytes)
    names = new Set(z.keys())
    check(names.has(`${dir}/${dir}.exe`), `the launcher is ${dir}/${dir}.exe`)
    check(names.has(`${APP}/bin/dnp-server.exe`), 'the Windows server is there')
    check(!names.has(`${dir}/electron.exe`), 'electron.exe is gone')
    const game = JSON.parse(new TextDecoder().decode(await z.get(`${APP}/game.json`).bytes()))
    check(game.modules?.[0] === mod.id && game.name === mod.name && game.studio === false, `game.json: ${JSON.stringify(game)}`)
    const pkg = JSON.parse(new TextDecoder().decode(await z.get(`${APP}/package.json`).bytes()))
    check(pkg.main === 'app/main.js' && pkg.name === mod.id && pkg.type === 'module', `package.json: ${JSON.stringify(pkg)}`)
  }
  check(names.has(`${APP}/app/main.js`), 'the shell is at resources/app/app/main.js')
  check(names.has(`${APP}/client/index.html`), 'the client is beside it')
  check(names.has(`${APP}/modules/${mod.id}/module.txt`), 'the module is under modules/<id>/')
  check(names.has(`${APP}/modules/${mod.id}/maps/${mod.maps[0]}`), 'with its baked map')
  check(![...names].some((n) => /\.map$|\.editor\.json$/.test(n) && n.includes('/modules/')), 'no .map or .editor.json')
  check(![...names].some((n) => n.startsWith(`${APP}/studio/`)), 'no studio unless asked')
  check(![...names].some((n) => n.endsWith('default_app.asar')), 'no Electron placeholder app')
}

// --- the Windows icon ------------------------------------------------------------
const winKit = join(PKG, 'build', 'kits', 'windows.zip')
if (existsSync(winKit)) {
  console.log('desktop: windows with the game\'s own icon')
  const kit = await readKit(readFileSync(winKit), 'windows')
  // Any PNG answers the structural question; the page renders real sizes
  // with icon.js. The 256 one is deliberately LARGE (the old slot is 19 KB),
  // which is what writing into the old slots could not take.
  const small = new Uint8Array(readFileSync(join(REPO, 'modules', 'starter', 'assets', 'sprites', 'SPIR.png')))
  const big = new Uint8Array(readFileSync(join(REPO, 'modules', 'starter', 'assets', 'textures', 'ROCKWALL1.png')))
  const { blob } = await buildDesktop(kit, mod, { ...opts, iconFor: async (n) => (n >= 256 ? big : small) })
  const z = readZip(new Uint8Array(await blob.arrayBuffer()))
  const exe = await z.get(`${dir}/${dir}.exe`).bytes()
  const exePath = join(OUT, 'icon-test.exe')
  writeFileSync(exePath, exe)
  const { iconGroup } = await import('../src/pe.js')
  const g = iconGroup(exe)
  check(g && g.images.map((i) => i.width).join() === '16,32,48,256', `the group keeps its four sizes (${g?.images.map((i) => i.width)})`)
  check(g.images.find((i) => i.width === 256).size === big.length, `the 256 px image is the ${big.length}-byte PNG`)
  console.log(`       ${relative(REPO, exePath)} (${big.length} bytes at 256 px; check with wrestool/objdump)`)
}

console.log(`== ${checks} checks, ${fails} failures ==`)
process.exit(fails ? 1 : 0)
