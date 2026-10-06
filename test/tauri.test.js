// The Tauri OPTION: a module, a Tauri kit and the Android kit, into a desktop
// game that runs in the OS's own web view.
//
//   node packager/test/tauri.test.js [module] [--run]      (default: starter)
//
// For every Tauri kit present: builds the game with the page's code and checks
// the archive (runner, server, game.json, the web tree with the shim in front
// of shell.js, the server's tree). On a Mac, the macOS one is unpacked with
// ditto and judged by codesign --verify --deep --strict; --run starts it and
// requires the runner to start the server, bring the link up and a player to
// join a level, then quits it and checks the server went with it.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'
import { readKit } from '../src/kit.js'
import { buildTauri, tauriKitName } from '../src/tauri.js'
import { defaultPackageId } from '../src/android.js'
import { moduleFromEntries } from '../src/module.js'
import { readZip } from '../src/zip.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const REPO = join(PKG, '..')
const args = process.argv.slice(2)
const RUN = args.includes('--run')
const MODULE = args.find((a) => !a.startsWith('--')) ?? 'starter'
const KITS = join(PKG, 'build', 'kits')
const OUT = join(PKG, 'build', 'test')
mkdirSync(OUT, { recursive: true })

let checks = 0
let fails = 0
const check = (ok, what) => { checks++; if (!ok) { fails++; console.log(`  FAIL ${what}`) } }
const run = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 1 << 26 })
function walk (dir) {
  const out = []
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p) }
  return out
}
const mod = await moduleFromEntries(walk(join(REPO, 'modules', MODULE)).map((p) => ({
  path: relative(join(REPO, 'modules'), p), size: statSync(p).size, read: async () => new Uint8Array(readFileSync(p))
})))
if (!existsSync(join(KITS, 'android.zip'))) { console.log('tauri: no Android kit (the trees come from it); skipped'); process.exit(0) }
const android = await readKit(readFileSync(join(KITS, 'android.zip')), 'android')
const icon = new Uint8Array(readFileSync(join(REPO, 'modules', 'starter', 'assets', 'textures', 'ROCKWALL1.png')))

for (const f of readdirSync(KITS).filter((n) => n.startsWith('tauri-') && n.endsWith('.zip'))) {
  const kit = await readKit(readFileSync(join(KITS, f)), 'tauri')
  check(tauriKitName(kit.info) + '.zip' === f, `${f} names itself ${tauriKitName(kit.info)}`)
  console.log(`tauri: ${tauriKitName(kit.info)}, ${MODULE}`)
  const t0 = Date.now()
  const { blob, filename } = await buildTauri(kit, android, mod, {
    label: mod.name, version: '1.2.3', bundleId: defaultPackageId(mod.id), iconFor: async () => icon
  }, (l) => console.log(`       ${l}`))
  const file = join(OUT, filename)
  writeFileSync(file, new Uint8Array(await blob.arrayBuffer()))
  console.log(`       ${(blob.size / 1048576).toFixed(1)} MB in ${Date.now() - t0} ms -> ${relative(REPO, file)}`)

  const os = kit.info.os
  const GAME = os === 'macos' ? `${mod.name}.app/Contents/Resources/game` : `${mod.name}/game`
  let names
  if (os === 'linux') {
    names = new Set(run('tar', ['-tzf', file]).stdout.trim().split('\n'))
  } else {
    names = new Set(readZip(new Uint8Array(await blob.arrayBuffer())).keys())
  }
  for (const p of ['game.json', 'web/index.html', 'web/shell.js', 'web/framing.js', `web/maps/${mod.maps[0]}`, `game/modules/${mod.id}/module.txt`, 'game/assets/props.txt']) {
    check(names.has(`${GAME}/${p}`), `${os}: ${GAME}/${p}`)
  }
  check(names.has(`${GAME}/bin/${os === 'windows' ? 'dnp-server.exe' : 'dnp-server'}`), `${os}: the server`)
  check(![...names].some((n) => n.includes('/web/studio/')), `${os}: no studio`)

  if (os === 'macos' && process.platform === 'darwin') {
    const dir = join(OUT, `tauri-${kit.info.arch}-${MODULE}`)
    rmSync(dir, { recursive: true, force: true })
    check(run('ditto', ['-x', '-k', file, dir]).status === 0, 'ditto unpacks it')
    const app = join(dir, `${mod.name}.app`)
    const shell = readFileSync(join(app, 'Contents/Resources/game/web/shell.js'), 'utf8')
    check(shell.indexOf('window.dnpNative =') < shell.indexOf("const native = window.dnpNative"), 'the runner shim comes before the shared shell')
    const v = run('codesign', ['--verify', '--deep', '--strict', app])
    check(v.status === 0, `codesign --verify --deep --strict: ${v.stderr.trim()}`)
    check(run('codesign', ['-dvvv', app]).stderr.includes(`Identifier=${defaultPackageId(mod.id)}`), 'signed under the game\'s id')
    if (RUN && kit.info.arch === (process.arch === 'arm64' ? 'arm64' : 'x64')) {
      console.log('tauri: starting the macOS app (a window opens for a few seconds)')
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const p = spawn(join(app, 'Contents/MacOS', mod.id), [], { stdio: ['ignore', 'pipe', 'pipe'], env })
      let log = ''
      p.stdout.on('data', (b) => { log += b }); p.stderr.on('data', (b) => { log += b })
      for (let i = 0; i < 120 && !/session 1 -> level/.test(log); i++) await new Promise((r) => setTimeout(r, 500))
      await new Promise((r) => setTimeout(r, 3000))
      p.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 2000))
      check(/\[runner\] server: /.test(log), 'the runner started the bundled server')
      check(/\[runner\] link up/.test(log), 'the link is up')
      check(/session 1 -> level/.test(log), 'a player joined a level')
      check(!/\[page\].*(Error|error)/.test(log), 'no page errors reported')
      const left = run('pgrep', ['-f', join(app, 'Contents/Resources/game/bin/dnp-server')]).stdout.trim()
      check(!left, 'quitting stops the server')
      if (fails) console.log(log.split('\n').slice(-25).join('\n'))
    }
  }
}
console.log(`== ${checks} checks, ${fails} failures ==`)
process.exit(fails ? 1 : 0)
