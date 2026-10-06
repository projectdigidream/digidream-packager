// The Android path, end to end, judged by Google's own tools.
//
//   node packager/test/android.test.js [module]      (default: starter)
//
// Runs the packager's browser code under node -- it uses only web APIs, which
// node 22 has -- on a module from modules/ and the kit from
// packager/scripts/build_kits.sh, then hands the APK to the SDK's apksigner
// and aapt2. Those are the ORACLES: the packager exists so a phone needs no
// SDK, but whether its output is a valid APK is a question for the SDK, not
// for the code that wrote it. Skips (loudly) without an SDK or a kit.
//
// The APK is left at packager/build/test/<module>.apk for an emulator run.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { readKit, buildApk, defaultPackageId, manifestFor, packageIdProblem } from '../src/android.js'
import { moduleFromEntries, moduleFromZip, packagingProblem } from '../src/module.js'
import { createIdentity, fingerprint } from '../src/x509.js'
import { readZip, writeZip } from '../src/zip.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const REPO = join(PKG, '..')
const MODULE = process.argv[2] ?? 'starter'

let checks = 0
let fails = 0
function check (ok, what) {
  checks++
  if (!ok) { fails++; console.log(`  FAIL ${what}`) }
}

const KIT = join(PKG, 'build', 'kits', 'android.zip')
const SDK = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Library', 'Android', 'sdk')
const btDir = join(SDK, 'build-tools')
const BT = existsSync(btDir) ? join(btDir, readdirSync(btDir).sort().at(-1)) : null
if (!existsSync(KIT)) { console.log(`android: no kit at ${KIT} -- run packager/scripts/build_kits.sh; skipped`); process.exit(0) }
if (!BT) { console.log(`android: no Android SDK build-tools under ${SDK}; skipped`); process.exit(0) }

function walk (dir) {
  const out = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p)
  }
  return out
}
function moduleFromDisk (dir) {
  const base = dirname(dir)
  return moduleFromEntries(walk(dir).map((p) => ({
    path: relative(base, p), size: statSync(p).size, read: async () => new Uint8Array(readFileSync(p))
  })))
}
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' })

// --- the manifest, alone --------------------------------------------------------
console.log('android: the manifest is renamed and nothing else changes')
const kit = await readKit(readFileSync(KIT))
check(kit.info.abi === 'arm64-v8a', `kit abi ${kit.info.abi}`)
const kitManifest = await kit.zip.get('AndroidManifest.xml').bytes()
const dump = async (bytes) => {
  const tmp = join(PKG, 'build', 'test', 'manifest-only.zip')
  mkdirSync(dirname(tmp), { recursive: true })
  writeFileSync(tmp, await writeZip([{ name: 'AndroidManifest.xml', data: bytes }]))
  const r = run(join(BT, 'aapt2'), ['dump', 'xmltree', '--file', 'AndroidManifest.xml', tmp])
  return r.stdout
}
const before = await dump(kitManifest)
const after = await dump(manifestFor(kitManifest, { packageId: 'org.example.test', label: 'Test Game', versionCode: 7, versionName: '1.2.3' }))
check(after.includes('package="org.example.test"'), 'package renamed')
check(after.includes(':label(0x01010001)="Test Game"'), 'label renamed')
check(/versionCode\(0x0101021b\)=7\b/.test(after), 'versionCode set')
check(after.includes(':versionName(0x0101021c)="1.2.3"'), 'versionName set')
// CONTROL: apart from those four, the dumps are the same lines.
const strip = (s) => s.split('\n').filter((l) => !/package=|:label\(|versionCode|versionName/.test(l)).join('\n')
check(strip(before) === strip(after), 'every other line of the manifest is unchanged')
check(after.includes('"com.digidream.app.MainActivity"'), 'the activity keeps its fully qualified class')

console.log('android: package ids')
check(defaultPackageId('starter') === 'com.digidream.starter', 'default id')
check(defaultPackageId('2048') === 'com.digidream.g2048', 'a leading digit is made legal')
check(packageIdProblem('com.digidream.starter') === null, 'a good id passes')
check(packageIdProblem('starter') !== null, 'CONTROL: one segment is refused')
check(packageIdProblem('com.new.game') !== null, 'CONTROL: a Java keyword is refused')

// --- the module --------------------------------------------------------------------
console.log(`android: ${MODULE}, from disk and from a studio-style zip`)
const mod = await moduleFromDisk(join(REPO, 'modules', MODULE))
check(packagingProblem(mod) === null, `${MODULE} is packageable: ${packagingProblem(mod)}`)
// The same module through the zip path a phone uses.
const zipped = await writeZip(await Promise.all([...mod.files].map(async ([p, f]) => ({ name: `${MODULE}/${p}`, data: await f.read(), compress: true }))))
const viaZip = await moduleFromZip(zipped)
check(viaZip.id === mod.id && viaZip.maps.join() === mod.maps.join() && viaZip.files.size === mod.files.size, 'the zip path sees the same module')
const empty = await moduleFromEntries([{ path: 'addon/module.txt', size: 9, read: async () => new TextEncoder().encode('name add\n') }])
check(packagingProblem(empty) !== null, 'CONTROL: a module.txt-only add-on is refused, with a reason')

// --- the APK -------------------------------------------------------------------------
console.log('android: build, sign, and ask the SDK')
const identity = await createIdentity({ commonName: 'Packager test' })
const t0 = Date.now()
const apk = await buildApk(kit, viaZip, {
  packageId: defaultPackageId(MODULE), label: mod.name, versionCode: 1, versionName: '1.0', identity
}, (l) => console.log(`       ${l}`))
console.log(`       ${(apk.length / 1048576).toFixed(1)} MB in ${Date.now() - t0} ms`)
const out = join(PKG, 'build', 'test', `${MODULE}.apk`)
writeFileSync(out, apk)

const v = run(join(BT, 'apksigner'), ['verify', '--verbose', '--print-certs', out])
check(v.status === 0, `apksigner verify: ${v.stderr || v.stdout}`)
check(/Verified using v2 scheme \(APK Signature Scheme v2\): true/.test(v.stdout), 'verified by v2')
const fp = await fingerprint(identity.certificate)
check(v.stdout.toLowerCase().includes(fp.replace(/:/g, '')), 'apksigner reports our certificate')
const za = run(join(BT, 'zipalign'), ['-c', '-p', '4', out])
check(za.status === 0, `zipalign -c: ${za.stdout}`)
const badging = run(join(BT, 'aapt2'), ['dump', 'badging', out]).stdout
check(badging.includes(`package: name='${defaultPackageId(MODULE)}' versionCode='1' versionName='1.0'`), `badging: ${badging.split('\n')[0]}`)
check(badging.includes(`application-label:'${mod.name}'`), 'badging label')

// The staged trees, as build_apk.sh would have laid them out.
const z = readZip(apk)
check(z.has(`assets/game/modules/${MODULE}/module.txt`), 'module.txt in the game tree')
check(z.has(`assets/web/maps/${mod.maps[0]}`), 'the first map in the web tree')
check(![...z.keys()].some((n) => n.endsWith('.map') || n.endsWith('.editor.json')), 'no .map or .editor.json shipped')
check(![...z.keys()].some((n) => n.startsWith('assets/web/studio/')), 'no studio unless asked')
check(!z.has('kit.json'), 'the kit\'s own table of contents is not shipped')
const start = new TextDecoder().decode(await z.get('assets/game/start.txt').bytes())
check(start.includes(`module=${MODULE}\n`) && start.includes(`map=${mod.maps[0]}\n`), 'start.txt names the module and map')

// --- the icon --------------------------------------------------------------------
console.log('android: a game with its own icon')
// Any PNG will do for the SDK's question; the page makes a proper 432 px layer
// with icon.js, which needs a browser (page.smoke.mjs covers that).
const iconPng = new Uint8Array(readFileSync(join(REPO, 'modules', 'starter', 'assets', 'sprites', 'SPIR.png')))
const iconApk = await buildApk(kit, viaZip, {
  packageId: defaultPackageId(MODULE), label: mod.name, versionCode: 2, versionName: '1.1', identity, icon: iconPng
})
const iconOut = join(PKG, 'build', 'test', `${MODULE}-icon.apk`)
writeFileSync(iconOut, iconApk)
check(run(join(BT, 'apksigner'), ['verify', iconOut]).status === 0, 'the icon build verifies')
const res = run(join(BT, 'aapt2'), ['dump', 'resources', iconOut]).stdout
check(/drawable\/ic_fg\s+\(\) \(file\) res\/drawable\/ic_fg\.png type=PNG/.test(res), 'the icon foreground is the PNG')
check(/mipmap\/ic_launcher\s+\(\) \(file\) res\/mipmap\/ic_launcher\.png type=PNG/.test(res), 'the fallback icon is the PNG')
check(res.includes('res/mipmap-anydpi-v26/ic_launcher.xml'), 'the adaptive icon still wraps it')
const iz = readZip(iconApk)
check(!iz.has('res/drawable/ic_fg.xml') && iz.has('res/drawable/ic_fg.png'), 'the vector is replaced, not shipped beside')
check(Buffer.compare(Buffer.from(await iz.get('res/drawable/ic_fg.png').bytes()), Buffer.from(iconPng)) === 0, 'the PNG is the bytes given')
// CONTROL: without an icon the engine's vector is what ships.
check(/res\/drawable\/ic_fg\.xml type=XML/.test(run(join(BT, 'aapt2'), ['dump', 'resources', out]).stdout), 'CONTROL: no icon given, the engine\'s vector')

console.log(`== ${checks} checks, ${fails} failures ==  (${relative(REPO, out)})`)
process.exit(fails ? 1 : 0)
