// A module and the macOS kit, into <Name>.app -- sealed and signed ad hoc.
//
// The kit holds Electron.app with every NESTED piece (its framework, the four
// helper apps, their libraries) already signed by the real `codesign -s -`,
// and their cdhashes in kit.json: none of that changes from game to game. What
// changes is the outer bundle -- its Info.plist names the game, its
// Resources/app is the game -- so that is what this seals and signs:
//
//   1. Resources/app = the desktop game tree (desktop.js addGameTree), the icon
//      as an .icns, Info.plist edited;
//   2. _CodeSignature/CodeResources: every resource by hash (SHA-1 in `files`,
//      SHA-256 in `files2`), every nested bundle by cdhash -- the plist
//      `codesign` writes, laid out as it lays it out (plist.js reproduces one
//      of codesign's byte for byte);
//   3. the main executable signed ad hoc, binding Info.plist and that seal
//      (macho.js; its CodeDirectory matches codesign's byte for byte).
//
// `codesign --verify --deep --strict` is the judge (packager/test/macos.test.js).

import { writeZip } from './zip.js'
import { addGameTree, folderName } from './desktop.js'
import { parsePlist, writePlist } from './plist.js'
import { signMain } from './macho.js'
import { makeIcns } from './icns.js'

const enc = new TextEncoder()
const digest = async (alg, b) => new Uint8Array(await crypto.subtle.digest(alg, b))
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('')
const unhex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16))

// codesign keeps its dictionaries in std::map order: by the UTF-8 BYTES of the
// key, which is not JavaScript's UTF-16 order once a path leaves ASCII.
function byteOrder (a, b) {
  const x = enc.encode(a)
  const y = enc.encode(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]
  return x.length - y.length
}

const t = (k, v) => [k, v]
const RULES = new Map([
  t('^Resources/', true),
  t('^Resources/.*\\.lproj/', new Map([t('optional', true), t('weight', { real: 1000 })])),
  t('^Resources/.*\\.lproj/locversion.plist$', new Map([t('omit', true), t('weight', { real: 1100 })])),
  t('^Resources/Base\\.lproj/', new Map([t('weight', { real: 1010 })])),
  t('^version.plist$', true)
])
const RULES2 = new Map([
  t('.*\\.dSYM($|/)', new Map([t('weight', { real: 11 })])),
  t('^(.*/)?\\.DS_Store$', new Map([t('omit', true), t('weight', { real: 2000 })])),
  t('^(Frameworks|SharedFrameworks|PlugIns|Plug-ins|XPCServices|Helpers|MacOS|Library/(Automator|Spotlight|LoginItems))/', new Map([t('nested', true), t('weight', { real: 10 })])),
  t('^.*', true),
  t('^Info\\.plist$', new Map([t('omit', true), t('weight', { real: 20 })])),
  t('^PkgInfo$', new Map([t('omit', true), t('weight', { real: 20 })])),
  t('^Resources/', new Map([t('weight', { real: 20 })])),
  t('^Resources/.*\\.lproj/', new Map([t('optional', true), t('weight', { real: 1000 })])),
  t('^Resources/.*\\.lproj/locversion.plist$', new Map([t('omit', true), t('weight', { real: 1100 })])),
  t('^Resources/Base\\.lproj/', new Map([t('weight', { real: 1010 })])),
  t('^[^/]+$', new Map([t('nested', true), t('weight', { real: 10 })])),
  t('^embedded\\.provisionprofile$', new Map([t('weight', { real: 20 })])),
  t('^version\\.plist$', new Map([t('weight', { real: 20 })]))
])

/**
 * The seal. resources: [{ path (relative to Contents/), data }] -- regular
 * files under Resources/; nested: [{ path, cdhash (hex) }] from kit.json.
 */
export async function codeResources (resources, nested) {
  const files = []
  const files2 = []
  for (const r of resources) {
    const optional = /^Resources\/.*\.lproj\//.test(r.path)
    const sha1 = await digest('SHA-1', r.data)
    const sha2 = await digest('SHA-256', r.data)
    files.push([r.path, optional ? new Map([t('hash', sha1), t('optional', true)]) : sha1])
    files2.push([r.path, new Map([t('hash2', sha2), ...(optional ? [t('optional', true)] : [])])])
  }
  for (const n of nested) {
    files2.push([n.path, new Map([t('cdhash', unhex(n.cdhash)), t('requirement', `cdhash H"${n.cdhash}"`)])])
  }
  files.sort((a, b) => byteOrder(a[0], b[0]))
  files2.sort((a, b) => byteOrder(a[0], b[0]))
  return writePlist(new Map([
    t('files', new Map(files)), t('files2', new Map(files2)), t('rules', RULES), t('rules2', RULES2)
  ]))
}

/**
 * opts: { label, bundleId, version, studio, iconFor? }
 *   iconFor(size) -> PNG bytes (icon.js macIcon), made into the .icns.
 * Returns { blob, filename }.
 */
export async function buildMac (kit, mod, opts, log = () => {}) {
  const { info, zip } = kit
  const name = folderName(opts.label, mod.id)
  const BUNDLE = info.bundle // runtime/Electron.app
  const C = `${name}.app/Contents`
  const APP = `${C}/Resources/app`

  const out = new Map()
  const resources = [] // what the seal lists: regular files under Resources/
  // .DS_Store is Finder's, and codesign's rules OMIT it: sealed anyway, it is
  // then reported missing ("a sealed resource is missing or invalid"). Left
  // out of the game entirely.
  const junk = (path) => /(^|\/)\.DS_Store$/.test(path)
  const add = (path, data, mode = 0o100644) => {
    if (junk(path)) return
    out.set(path, { name: path, data, mode, compress: true })
    if (path.startsWith(`${C}/Resources/`)) resources.push({ path: path.slice(C.length + 1), data })
  }
  const fromKit = async (path, e) => {
    if (junk(path)) return
    if (path.startsWith(`${C}/Resources/`) && (e.mode & 0o170000) !== 0o120000) {
      add(path, await e.bytes(), e.mode ?? 0o100644)
    } else {
      out.set(path, { name: path, raw: { method: e.method, crc: e.crc, size: e.size, data: e.raw }, mode: e.mode ?? 0o100644 })
    }
  }

  // 1. Electron.app, minus what this replaces.
  const SKIP = new Set([`${BUNDLE}/Contents/Info.plist`, `${BUNDLE}/Contents/MacOS/Electron`,
    `${BUNDLE}/Contents/_CodeSignature/CodeResources`, `${BUNDLE}/Contents/Resources/default_app.asar`])
  for (const [p, e] of zip) {
    if (!p.startsWith(`${BUNDLE}/`) || SKIP.has(p)) continue
    if (opts.iconFor && p === `${BUNDLE}/Contents/Resources/electron.icns`) continue
    await fromKit(`${name}.app/${p.slice(BUNDLE.length + 1)}`, e)
  }
  if (opts.iconFor) {
    add(`${C}/Resources/electron.icns`, await makeIcns(opts.iconFor))
    log('icon: electron.icns replaced with the game\'s')
  }
  const n = await addGameTree({ zip, mod, opts, APP, add, fromKit, platform: `Darwin-${info.arch}` })

  // 2. Info.plist: the game's name, id and version. ElectronAsarIntegrity
  //    vouches for default_app.asar, which is gone.
  const plist = parsePlist(new TextDecoder().decode(await zip.get(`${BUNDLE}/Contents/Info.plist`).bytes()))
  plist.set('CFBundleName', opts.label.slice(0, 15))
  plist.set('CFBundleDisplayName', opts.label)
  plist.set('CFBundleIdentifier', opts.bundleId)
  plist.set('CFBundleShortVersionString', opts.version || '1.0')
  plist.set('CFBundleVersion', opts.version || '1.0')
  plist.set('LSApplicationCategoryType', 'public.app-category.games')
  plist.delete('ElectronAsarIntegrity')
  const infoPlist = writePlist(plist)
  out.set(`${C}/Info.plist`, { name: `${C}/Info.plist`, data: infoPlist, mode: 0o100644, compress: true })

  // 3. The seal, then the signature that binds it.
  log(`sealing ${resources.length} resource file(s) and ${info.nested.length} nested bundle(s)`)
  const seal = await codeResources(resources, info.nested)
  out.set(`${C}/_CodeSignature/CodeResources`, { name: `${C}/_CodeSignature/CodeResources`, data: seal, mode: 0o100644, compress: true })
  const { bytes: exe, cdhash } = await signMain(await zip.get(`${BUNDLE}/Contents/MacOS/Electron`).bytes(), opts.bundleId, { infoPlist, codeResources: seal })
  out.set(`${C}/MacOS/Electron`, { name: `${C}/MacOS/Electron`, data: exe, mode: 0o100755, compress: true })
  log(`signed ad hoc: ${opts.bundleId}, cdhash ${hex(cdhash)}`)

  log(`module ${mod.id}: ${n} file(s), ${mod.maps.length} level(s); macOS ${info.arch}, Electron ${info.electron}`)
  const entries = [...out.values()]
  log(`zipping ${entries.length} entries`)
  const bytes = await writeZip(entries)
  return { blob: new Blob([bytes], { type: 'application/zip' }), filename: `${name}-macos-${info.arch}.zip` }
}
