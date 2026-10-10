// A module and the Android kit, into a signed APK.
//
// The kit is engine/scripts/build_apk.sh's own output with the module taken
// out (packager/scripts/build_kits.sh), so what this adds back must follow
// that script's staging rules exactly -- they are restated here, and each one
// names the lines it mirrors, because a rule that drifts from the script is a
// game that works from the command line and not from the packager.

import { writeZip } from './zip.js'
import { readKit } from './kit.js'
import { decodeAxml, encodeAxml, findElement, setAttr, TYPE, ANDROID_NS } from './axml.js'
import { signApkV2 } from './apksign.js'
import { replaceTableStrings } from './arsc.js'

const ART = ['textures', 'sprites', 'music', 'sounds', 'ui']
// Already compressed: deflating again costs time and gains nothing.
const STORE = /\.(png|jpe?g|webp|gif|ogg|mp3|mp4|zip)$/i

/** A package id from a module id: com.digidream.<id>, made legal. */
export function defaultPackageId (id) {
  let seg = id.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '')
  if (!seg || /^[0-9]/.test(seg)) seg = 'g' + seg
  return `com.digidream.${seg}`
}

export function packageIdProblem (id) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(id)) {
    return 'a package id is two or more dot-separated names, each starting with a letter (com.example.game)'
  }
  const reserved = new Set(['abstract', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null'])
  const bad = id.split('.').find((s) => reserved.has(s))
  return bad ? `'${bad}' is a Java keyword and cannot be part of a package id` : null
}

/**
 * The two trees every shell built on the Android kit's staging serves: the web
 * tree the page loads and the server's tree of files -- build_apk.sh's rules,
 * restated (see buildApk). `to(name)` maps the kit's own names
 * ("assets/web/...", "assets/game/...") to where this shell keeps them: the APK
 * keeps them as they are, the Tauri runner under game/ (tauri.js).
 */
export async function stageTrees (zip, mod, opts, put, copyKit, to) {
  const id = mod.id
  const map = opts.map
  const modFile = (p) => mod.files.get(p)
  const modRead = async (p) => (modFile(p) ? modFile(p).read() : null)
  // 2. The web tree: the kit's (the client, the synth, the engine's own art).
  for (const [name, e] of zip) {
    if (!name.startsWith('assets/web/')) continue
    if (name.startsWith('assets/web/studio/') && !opts.studio) continue
    copyKit(to(name), e)
  }
  // Art, the module winning per FILE (build_apk.sh "for kind in textures ...").
  let art = 0
  for (const [p, f] of mod.files) {
    const m = /^assets\/([^/]+)\/(.+)$/.exec(p)
    if (!m || !ART.includes(m[1])) continue
    put(to(`assets/web/${m[1]}/${m[2]}`), await f.read()); art++
  }
  // props.txt and animations.txt CONCATENATED, engine then module under a
  // "# --- <module> ---" header (build_apk.sh "for f in props.txt animations.txt").
  for (const f of ['props.txt', 'animations.txt']) {
    const engine = zip.get(`assets/web/${f}`) ? await zip.get(`assets/web/${f}`).bytes() : new Uint8Array(0)
    const mine = await modRead(`assets/${f}`)
    put(to(`assets/web/${f}`), mine ? concat(engine, text(`\n# --- ${id} ---\n`), mine) : engine)
  }
  // The baked maps the page loads (build_apk.sh: cp maps/*.dnpm web/maps/).
  for (const m of mod.maps) put(to(`assets/web/maps/${m}`), await modRead(`maps/${m}`))

  // 3. The game tree the server reads as files (build_apk.sh section 4).
  for (const [name, e] of zip) if (name.startsWith('assets/game/')) copyKit(to(name), e)
  const G = to(`assets/game/modules/${id}`)
  const props = await modRead('assets/props.txt')
  if (props) put(`${G}/assets/props.txt`, props)
  const skip = (p) => /\.map$|\.editor\.json$/.test(p) // find -delete in build_apk.sh
  let gameFiles = 0
  for (const [p, f] of mod.files) {
    if (!p.startsWith('maps/') || skip(p)) continue
    put(`${G}/${p}`, await f.read()); gameFiles++
  }
  if (modFile('module.txt')) put(`${G}/module.txt`, await modRead('module.txt'))
  if (opts.studio) {
    if (modFile('module.studio.json')) put(`${G}/module.studio.json`, await modRead('module.studio.json'))
    for (const [p, f] of mod.files) {
      if (p.startsWith('assets/') && !skip(p)) put(`${G}/${p}`, await f.read())
    }
  }
  const built = new Date().toISOString().slice(0, 16).replace('T', ' ')
  put(to('assets/game/start.txt'), text(
    '# Written by the packager. Read by MainActivity at first launch.\n' +
    `module=${id}\nmap=${map}\nstudio=${opts.studio ? 1 : 0}\nlog=${opts.log ? 1 : 0}\nbuilt=${built}\n`))

  return { art, gameFiles }
}

/** The Android kit (kit.js), checked to be one. */
export const readAndroidKit = (bytes) => readKit(bytes, 'android')

/**
 * The manifest, renamed. Package, label, version -- everything else is the
 * engine's. The activity's name is already fully qualified in the compiled
 * manifest (com.digidream.app.MainActivity), so the classes keep their own
 * package whatever the app's is called.
 */
export function manifestFor (kitManifest, { packageId, label, versionCode, versionName }) {
  const doc = decodeAxml(kitManifest)
  const manifest = findElement(doc, 'manifest')
  const application = findElement(doc, 'application')
  if (!manifest || !application) throw new Error('the kit manifest has no <manifest> or <application>')
  setAttr(manifest, { name: 'package', type: TYPE.STRING, value: packageId })
  setAttr(manifest, { ns: ANDROID_NS, name: 'versionCode', resId: 0x0101021b, type: TYPE.INT_DEC, value: versionCode })
  setAttr(manifest, { ns: ANDROID_NS, name: 'versionName', resId: 0x0101021c, type: TYPE.STRING, value: versionName })
  setAttr(application, { ns: ANDROID_NS, name: 'label', resId: 0x01010001, type: TYPE.STRING, value: label })
  return encodeAxml(doc)
}

const concat = (...xs) => {
  const out = new Uint8Array(xs.reduce((a, b) => a + b.length, 0))
  let o = 0
  for (const x of xs) { out.set(x, o); o += x.length }
  return out
}
const text = (s) => new TextEncoder().encode(s)

/**
 * opts: { packageId, label, versionCode, versionName, map, studio, identity,
 *         icon? }   icon: PNG bytes (icon.js makes them from any picture)
 * log:  (line) => void
 * Returns the signed APK bytes.
 */
export async function buildApk (kit, mod, opts, log = () => {}) {
  const { zip } = kit
  const id = mod.id
  const map = opts.map || mod.maps[0]
  if (!mod.maps.includes(map)) throw new Error(`no maps/${map} in ${id}`)

  // name -> { data } or { raw }, in the order they go into the archive.
  const out = new Map()
  // align: 4 on everything -- zipalign's rule is that EVERY stored entry starts
  // on a 4-byte boundary (writeZip ignores it for deflated ones).
  const put = (name, data) => out.set(name, { name, data, compress: !STORE.test(name), align: 4 })
  const copyKit = (name, e) => out.set(name, { name, raw: { method: e.method, crc: e.crc, size: e.size, data: e.raw }, align: 4 })
  const modFile = (p) => mod.files.get(p)
  const modRead = async (p) => (modFile(p) ? modFile(p).read() : null)

  // 1. The manifest first (where aapt2 puts it), then the kit's binaries.
  put('AndroidManifest.xml', manifestFor(await zip.get('AndroidManifest.xml').bytes(), opts))
  // resources.arsc must be STORED and 4-aligned (target SDK 30+), whatever the
  // kit's zip did to it.
  //
  // THE ICON. The launcher icon's foreground and the pre-26 fallback are file
  // resources whose paths sit in the table's string pool; pointing them at a
  // .png makes Android decode a bitmap where it parsed the engine's vector.
  // The XML files they replace are left out (arsc.js).
  let arsc = await zip.get('resources.arsc').bytes()
  const ICON_FILES = { 'res/drawable/ic_fg.xml': 'res/drawable/ic_fg.png', 'res/mipmap/ic_launcher.xml': 'res/mipmap/ic_launcher.png' }
  if (opts.icon) {
    const r = replaceTableStrings(arsc, (s) => ICON_FILES[s])
    if (r.changed !== Object.keys(ICON_FILES).length) {
      throw new Error(`the kit's resource table does not name the icon files this packager knows (${r.changed} of ${Object.keys(ICON_FILES).length}); rebuild the kit or update android.js`)
    }
    arsc = r.bytes
    for (const png of Object.values(ICON_FILES)) out.set(png, { name: png, data: opts.icon, compress: false, align: 4 })
    log('icon: the game\'s own')
  }
  out.set('resources.arsc', { name: 'resources.arsc', data: arsc, compress: false, align: 4 })
  for (const [name, e] of zip) {
    if (name === 'kit.json' || name === 'AndroidManifest.xml' || name === 'resources.arsc') continue
    if (opts.icon && ICON_FILES[name]) continue
    if (name.startsWith('assets/web/studio/') && !opts.studio) continue
    if (name.startsWith('assets/')) continue // the asset trees are merged below
    copyKit(name, e)
  }

  // 2-3. The web tree and the server's tree (stageTrees, below).
  const { art, gameFiles } = await stageTrees(zip, mod, { ...opts, map }, put, copyKit, (n) => n)

  log(`module ${id}: ${mod.maps.length} level(s), starting on ${map}; ${art} art file(s) over the engine's, ${gameFiles} file(s) for the server`)
  log(`manifest: ${opts.packageId} "${opts.label}" ${opts.versionName} (${opts.versionCode})`)

  // 4. Zip (aligned as it is written), then sign.
  const entries = [...out.values()]
  log(`zipping ${entries.length} entries`)
  const unsigned = await writeZip(entries)
  log(`signing (APK Signature Scheme v2), ${(unsigned.length / 1048576).toFixed(1)} MB`)
  return signApkV2(unsigned, opts.identity)
}
