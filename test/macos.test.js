// The macOS path: a module and the macOS kit, into <Name>.app, judged by
// Apple's own tools on this Mac.
//
//   node packager/test/macos.test.js [module] [--run] [--arch x64]   (default: starter)
//
// Runs the page's code under node, unpacks the zip with ditto (what Finder's
// Archive Utility does), and asks:
//   codesign --verify --deep --strict    -- the seal and every signature hold
//   codesign -d                          -- identifier, ad hoc, sealed resources
//   plutil                               -- the game's name, id, version
// --run also STARTS the app (a window opens briefly), waits for the shell to
// start its server and a player to join a level, quits it, and checks the
// server went with it. Needs macOS; skips elsewhere.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'
import { readKit } from '../src/kit.js'
import { buildMac } from '../src/macos.js'
import { defaultPackageId } from '../src/android.js'
import { moduleFromEntries } from '../src/module.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const REPO = join(PKG, '..')
const args = process.argv.slice(2)
const RUN = args.includes('--run')
const ai = args.indexOf('--arch')
const ARCH = ai >= 0 ? args[ai + 1] : null
const MODULE = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--arch') ?? 'starter'
const OUT = join(PKG, 'build', 'test')
mkdirSync(OUT, { recursive: true })

if (process.platform !== 'darwin') { console.log('macos: not a Mac; skipped'); process.exit(0) }
// --arch x64 builds the Intel app here; it verifies, and runs under Rosetta.
const arch = ARCH ?? (process.arch === 'arm64' ? 'arm64' : 'x64')
const KIT = join(PKG, 'build', 'kits', `macos-${arch}.zip`)
if (!existsSync(KIT)) { console.log(`macos: no kit at ${KIT}; skipped`); process.exit(0) }

let checks = 0
let fails = 0
const check = (ok, what) => { checks++; if (!ok) { fails++; console.log(`  FAIL ${what}`) } }
const run = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 1 << 26 })

function walk (dir) {
  const out = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p)
  }
  return out
}
const mod = await moduleFromEntries(walk(join(REPO, 'modules', MODULE)).map((p) => ({
  path: relative(join(REPO, 'modules'), p), size: statSync(p).size, read: async () => new Uint8Array(readFileSync(p))
})))

console.log(`macos: ${MODULE}, ${arch}`)
const kit = await readKit(readFileSync(KIT), 'macos')
const icon = new Uint8Array(readFileSync(join(REPO, 'modules', 'starter', 'assets', 'textures', 'ROCKWALL1.png')))
const t0 = Date.now()
const { blob, filename } = await buildMac(kit, mod, {
  label: mod.name, bundleId: defaultPackageId(mod.id), version: '1.2.3', studio: false, iconFor: async () => icon
}, (l) => console.log(`       ${l}`))
const zip = join(OUT, filename)
writeFileSync(zip, new Uint8Array(await blob.arrayBuffer()))
console.log(`       ${(blob.size / 1048576).toFixed(1)} MB in ${Date.now() - t0} ms -> ${relative(REPO, zip)}`)

const dir = join(OUT, `macos-${arch}-${MODULE}`)
rmSync(dir, { recursive: true, force: true })
check(run('ditto', ['-x', '-k', zip, dir]).status === 0, 'ditto unpacks it')
const app = join(dir, `${mod.name}.app`)
check(existsSync(app), `${mod.name}.app is there`)

const v = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
check(v.status === 0, `codesign --verify --deep --strict: ${v.stderr.trim().split('\n').slice(-2).join(' | ')}`)
const d = run('codesign', ['-dvvv', app]).stderr
check(d.includes(`Identifier=${defaultPackageId(mod.id)}`), 'signed under the game\'s bundle id')
check(/Signature=adhoc/.test(d), 'ad hoc')
check(/Sealed Resources version=2/.test(d), 'resources sealed')
const dr = run('codesign', ['-d', '-r-', app])
check(/designated => cdhash H"/.test(dr.stdout + dr.stderr), 'the designated requirement is its cdhash')

const plist = (k) => run('plutil', ['-extract', k, 'raw', join(app, 'Contents/Info.plist')]).stdout.trim()
check(plist('CFBundleName') === mod.name.slice(0, 15), `CFBundleName ${plist('CFBundleName')}`)
check(plist('CFBundleIdentifier') === defaultPackageId(mod.id), 'CFBundleIdentifier')
check(plist('CFBundleShortVersionString') === '1.2.3', 'version')
check(run('plutil', ['-extract', 'ElectronAsarIntegrity', 'raw', join(app, 'Contents/Info.plist')]).status !== 0, 'no integrity entry for the removed default_app.asar')
check(existsSync(join(app, 'Contents/Resources/app/modules', mod.id, 'module.txt')), 'the module is in Resources/app/modules')
check(statSync(join(app, 'Contents/Resources/app/bin/dnp-server')).mode & 0o111, 'the server is executable')
check(statSync(join(app, 'Contents/MacOS/Electron')).mode & 0o111, 'the main executable is executable')
const fw = join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework')
check(run('test', ['-L', fw]).status === 0, 'the framework\'s symlinks survived')
const icns = readFileSync(join(app, 'Contents/Resources/electron.icns'))
check(icns.subarray(0, 4).toString() === 'icns' && icns.readUInt32BE(4) === icns.length, 'the .icns is well formed')

// CONTROL: one changed byte in a sealed resource and the seal must break.
const victim = join(app, 'Contents/Resources/app/game.json')
const saved = readFileSync(victim)
writeFileSync(victim, Buffer.concat([saved, Buffer.from(' ')]))
check(run('codesign', ['--verify', '--deep', '--strict', app]).status !== 0, 'CONTROL: a changed resource breaks the seal')
writeFileSync(victim, saved)

if (RUN) {
  console.log('macos: starting the app (a window opens for a few seconds)')
  // ELECTRON_RUN_AS_NODE must not reach it: VS Code's terminals export it, and
  // with it set the app runs as plain Node, prints nothing and exits -- which
  // looks exactly like a broken signature (docs/APP.md has the same trap).
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const p = spawn(join(app, 'Contents/MacOS/Electron'), [], { stdio: ['ignore', 'pipe', 'pipe'], env })
  let log = ''
  p.stdout.on('data', (b) => { log += b }); p.stderr.on('data', (b) => { log += b })
  // Up to 90 s: an Intel app on Apple silicon starts under Rosetta, whose first
  // run translates Electron's whole x86-64 binary.
  for (let i = 0; i < 180 && !/session 1 -> level/.test(log); i++) await new Promise((r) => setTimeout(r, 500))
  await new Promise((r) => setTimeout(r, 4000))
  p.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 2000))
  const left = run('pgrep', ['-f', join(app, 'Contents/Resources/app/bin/dnp-server')]).stdout.trim()
  check(!left, 'quitting the app stops its server')
  check(/\[app\] server: /.test(log), 'the shell started the bundled server')
  check(/session 1 -> level/.test(log), 'a player joined a level')
  check(!/Uncaught|FATAL/.test(log), 'no page or process errors')
  if (fails) console.log(log.split('\n').slice(-20).join('\n'))
}

console.log(`== ${checks} checks, ${fails} failures ==`)
process.exit(fails ? 1 : 0)
