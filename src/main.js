// The packager's page.
//
// Holds the four choices -- module, platform, the game's details, the key --
// and says, at every moment, what is still missing before Build can run. No
// work leaves the page: the kit is fetched from beside it (or picked as a
// file), the module is read from the user's disk, and the result is handed
// back as a download.

import { moduleFromZip, moduleFromFileList, packagingProblem } from './module.js'
import { buildApk, defaultPackageId, packageIdProblem } from './android.js'
import { buildDesktop, windowsPathProblems } from './desktop.js'
import { buildMac } from './macos.js'
import { buildTauri } from './tauri.js'
import { readKit } from './kit.js'
import { host } from './host.js'
import { listKits, putKit, getKitBytes, removeKit } from './kitstore.js'
import { releaseKits, megabytes, RELEASES_PAGE } from './releases.js'
import { loadIdentity, newIdentity, backupJson, restoreJson } from './keys.js'
import { fingerprint } from './x509.js'
import { adaptiveIcon, squareIcon, macIcon } from './icon.js'
import { get as dbGet, put as dbPut, del as dbDel } from './store.js'

const $ = (id) => document.getElementById(id)

// Every platform the packager knows, whether or not a kit exists for it yet.
// `why` is what is shown while it cannot be built.
const TARGETS = [
  // `store`: the kit's name in the kit store (kitstore.js) and, + '.zip', the
  // file a bundled kit has beside the page.
  { id: 'android', name: 'Android', out: 'APK, arm64', store: 'android' },
  // `tauri`: the Tauri kit's store name, for the Tauri shell option.
  { id: 'linux', name: 'Linux', out: 'x86-64, .tar.gz', store: 'linux', tauri: 'tauri-linux', desktop: true },
  { id: 'windows', name: 'Windows', out: 'x86-64, .zip', store: 'windows', tauri: 'tauri-windows', desktop: true },
  { id: 'macos', name: 'macOS', out: 'Apple silicon, .zip', store: 'macos-arm64', tauri: 'tauri-macos-arm64', kitType: 'macos', desktop: true, mac: true },
  { id: 'macos-x64', name: 'macOS (Intel)', out: 'x86-64, .zip', store: 'macos-x64', tauri: 'tauri-macos-x64', kitType: 'macos', desktop: true, mac: true },
  { id: 'ios', name: 'iOS', out: 'app', kit: null, why: 'later' }
]

const state = {
  module: null,
  target: 'android',
  kits: {}, // target id -> { info, zip }
  // THE DESKTOP SHELL: Electron (the default, self-contained) or Tauri (small,
  // runs in the OS's own web view). Remembered per browser.
  shell: (() => { try { return localStorage.getItem('packager:shell') === 'tauri' ? 'tauri' : 'electron' } catch { return 'electron' } })(),
  storeAvail: {}, // kit-store name -> 'stored' | 'bundled' | null
  kitsByStore: {}, // kit-store name -> { info, zip }, loaded this session
  outputBlob: null,
  outputName: null,
  identity: null,
  // The picture the game's icon is made from (a Blob), or null for the
  // engine's. Each platform derives its own form at build time: the adaptive
  // layer for Android, square sizes for the desktop.
  picture: null,
  output: null
}

const log = (line) => { $('log').textContent += line + '\n'; $('log').scrollTop = 1e9 }
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`

// ---- module -------------------------------------------------------------------

async function takeModule (load) {
  $('mod-summary').textContent = 'Reading…'
  try {
    state.module = await load()
    const m = state.module
    const problem = packagingProblem(m)
    $('mod-summary').innerHTML =
      `<b>${esc(m.name)}</b> (${esc(m.id)}) — ${m.maps.length} level(s), ${m.files.size} files, ${mb(m.bytes)}` +
      (m.controls ? `, ${esc(m.controls)} controls` : '') +
      (m.about ? `<br>${esc(m.about)}` : '') +
      (problem ? `<br><span class="problem">${esc(problem)}</span>` : '')
    // The details follow the module, unless this module was packaged before.
    const saved = remembered(m.id)
    $('label').value = saved?.label ?? m.name
    $('pkg').value = saved?.packageId ?? defaultPackageId(m.id)
    $('vname').value = saved?.versionName ?? '1.0'
    $('vcode').value = saved?.versionCode ? saved.versionCode + 1 : 1
    $('map').innerHTML = m.maps.map((x) => `<option>${esc(x)}</option>`).join('')
    // The module's own starting map (the studio's Settings) first; else the
    // map the last build of it was told; else the first by name, as the game.
    if (m.start) $('map').value = m.start
    else if (saved?.map && m.maps.includes(saved.map)) $('map').value = saved.map
    // Game only unless asked: the studio is for making, and a module carrying
    // a studio document is still usually being shipped to players.
    $('studio').value = saved?.studio ? '1' : '0'
    // A log file (the server's output and the game's console, where the
    // player can open it): for a build being tested, off for one being shipped.
    $('logfile').value = saved?.log ? '1' : '0'
    const stored = await dbGet('icons', m.id).catch(() => null)
    setPicture(stored instanceof Blob ? stored : null, false)
  } catch (e) {
    state.module = null
    $('mod-summary').innerHTML = `<span class="problem">${esc(e.message)}</span>`
  }
  refresh()
}

$('pick-zip').addEventListener('change', (ev) => {
  const f = ev.target.files[0]
  if (f) takeModule(async () => moduleFromZip(new Uint8Array(await f.arrayBuffer())))
  ev.target.value = ''
})
$('pick-dir').addEventListener('change', (ev) => {
  const files = ev.target.files
  if (files.length) takeModule(() => moduleFromFileList(files))
  ev.target.value = ''
})
// A host with a module of its own (the suite) hands it in: nothing to pick.
if (host.initialModule) takeModule(async () => moduleFromZip(await host.initialModule()))
// Phones have no folder picker; offering one that opens a file chooser is worse
// than not offering it.
if (!('webkitdirectory' in document.createElement('input')) || /Android|iPhone|iPad/i.test(navigator.userAgent)) {
  $('pick-dir-label').classList.add('hidden')
}

// ---- icon ---------------------------------------------------------------------------

async function setPicture (blob, store = true) {
  state.picture = blob
  // Remembered per module (IndexedDB), so an update keeps its icon.
  if (store && state.module) (blob ? dbPut('icons', state.module.id, blob) : dbDel('icons', state.module.id)).catch(() => {})
  drawIcon()
}

// The preview shows what the chosen platform will show: Android's layer under a
// circle mask, or the plain square a desktop draws.
async function drawIcon () {
  const prev = $('icon-prev')
  if (prev.dataset.url) URL.revokeObjectURL(prev.dataset.url)
  delete prev.dataset.url
  const tgt = TARGETS.find((t) => t.id === state.target)
  const desktop = tgt?.desktop
  prev.classList.toggle('square', !!desktop)
  prev.classList.toggle('adaptive', !desktop && !!state.picture)
  if (!state.picture) { prev.innerHTML = '<span>engine icon</span>'; return }
  try {
    const png = tgt?.mac ? await macIcon(state.picture, 144) : desktop ? await squareIcon(state.picture, 144) : await adaptiveIcon(state.picture)
    const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }))
    prev.dataset.url = url
    prev.innerHTML = `<img alt="" src="${url}">`
  } catch (e) {
    prev.innerHTML = '<span>unreadable</span>'
    $('details-problem').textContent = `That picture could not be read: ${e.message}`
  }
}

$('pick-icon').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]
  ev.target.value = ''
  if (!f) return
  // Proven readable before it is kept.
  try { await createImageBitmap(f); setPicture(f) } catch (e) { $('details-problem').textContent = `That picture could not be read: ${e.message}` }
})
$('icon-clear').addEventListener('click', () => setPicture(null))

// ---- remembered per module ----------------------------------------------------------
// The last build's details, so the next one starts from them and the version
// code is already one higher. A per-browser convenience, nothing more.

function remembered (id) {
  try { return JSON.parse(localStorage.getItem(`packager:${id}`)) } catch { return null }
}
function remember (id, v) {
  try { localStorage.setItem(`packager:${id}`, JSON.stringify(v)) } catch {}
}

// ---- targets and kits -----------------------------------------------------------------

const usesTauri = (t) => state.shell === 'tauri' && !!t?.tauri
// The kits a target needs with the current shell: its own, or for Tauri the
// Tauri kit AND the Android kit (whose staged trees the runner serves).
const kitsNeeded = (t) => (usesTauri(t) ? [t.tauri, 'android'] : t.store ? [t.store] : [])
const hasKit = (name) => !!state.kitsByStore[name] || !!state.storeAvail[name]
const available = (t) => kitsNeeded(t).length > 0 && kitsNeeded(t).every(hasKit)

function drawTargets () {
  $('targets').innerHTML = TARGETS.map((t) => {
    const have = available(t)
    const sub = have ? `${t.out}${usesTauri(t) ? ', Tauri' : ''}` : (t.why ?? (usesTauri(t) ? 'no Tauri kit yet: pick to get it' : 'no kit yet: pick to get it'))
    return `<button class="target" data-id="${t.id}" aria-pressed="${state.target === t.id}">
      <b>${t.name}</b><small>${esc(sub)}</small></button>`
  }).join('')
  for (const b of $('targets').querySelectorAll('.target')) {
    b.addEventListener('click', () => { state.target = b.dataset.id; drawTargets(); drawIcon(); refresh() })
  }
  drawKitGet()
}

// Where a target's kit can come from, in order: this session, the kit store
// (loaded once, kept), or bundled with the tool (host.kitsBase).
async function probeKits () {
  const stored = new Map((await listKits()).map((k) => [k.name, k.info]))
  const names = new Set(TARGETS.flatMap((t) => [t.store, t.tauri]).filter(Boolean))
  await Promise.all([...names].map(async (name) => {
    if (stored.has(name)) { state.storeAvail[name] = 'stored'; return }
    try {
      const r = await fetch(`${host.kitsBase}${name}.zip`, { method: 'HEAD', cache: 'no-store' })
      state.storeAvail[name] = r.ok ? 'bundled' : null
    } catch { state.storeAvail[name] = null }
  }))
  $('kit-list').innerHTML = stored.size
    ? 'Kept in this ' + (host.kind === 'browser' ? 'browser' : 'app') + ': ' + [...stored].map(([n, i]) =>
        `<span class="kit">${esc(n)} <small>engine ${esc(i.engine)}</small> <button data-rm="${esc(n)}" title="Remove">✕</button></span>`).join(' ')
    : ''
  for (const b of $('kit-list').querySelectorAll('[data-rm]')) {
    b.addEventListener('click', async () => {
      await removeKit(b.dataset.rm)
      delete state.kitsByStore[b.dataset.rm]
      probeKits()
    })
  }
  // Nobody chose a shell yet, and only Tauri kits are at hand (the suite
  // preloads those: they are ~2 MB, the Electron ones ~150): start on Tauri,
  // so the desktop targets are buildable rather than "no kit".
  let chose = null
  try { chose = localStorage.getItem('packager:shell') } catch {}
  const has = (n) => !!state.storeAvail[n]
  const desktops = TARGETS.filter((t) => t.desktop)
  if (!chose && state.shell === 'electron' && !desktops.some((t) => has(t.store)) && desktops.some((t) => has(t.tauri))) state.shell = 'tauri'
  drawTargets()
  refresh()
}

// ---- kits from the engine's releases ----------------------------------------------------

$('kit-releases').href = RELEASES_PAGE
// The latest engine release's kits, asked for once (a promise, so two draws share it).
let releaseAsk = null
const release = () => (releaseAsk ??= releaseKits().catch((e) => ({ error: e.message, kits: {} })))

// For the chosen platform, a download button per kit it lacks.
async function drawKitGet () {
  const t = TARGETS.find((x) => x.id === state.target)
  const lacking = kitsNeeded(t).filter((n) => !hasKit(n))
  const box = $('kit-get')
  if (!lacking.length) { box.innerHTML = ''; return }
  box.textContent = 'Looking for the kit in the engine\'s releases…'
  const rel = await release()
  if (TARGETS.find((x) => x.id === state.target) !== t) return
  if (rel.error) { box.innerHTML = `<span class="problem">${esc(rel.error)}</span> Download a kit from <a href="${RELEASES_PAGE}" target="_blank" rel="noopener">the engine's releases</a> and load it with "Load a kit file".`; return }
  box.innerHTML = lacking.map((n) => {
    const k = rel.kits[n]
    return k ? `<button class="btn" data-get-kit="${esc(n)}">Download the ${esc(n)} kit (${megabytes(k.size)}, engine ${esc(rel.tag)})</button>`
      : `<span class="problem">The engine release ${esc(rel.tag)} has no ${esc(n)} kit.</span>`
  }).join(' ')
  for (const b of box.querySelectorAll('[data-get-kit]')) b.addEventListener('click', () => getKit(b.dataset.getKit, rel))
}

async function getKit (name, rel) {
  const k = rel.kits[name]
  const box = $('kit-get')
  // A browser tab cannot read the file (releases.js): the browser downloads it,
  // and the user loads it. The desktop app fetches it here.
  if (!host.download) {
    const a = document.createElement('a')
    a.href = k.url; a.target = '_blank'; a.rel = 'noopener'
    a.click()
    box.innerHTML = `Your browser is downloading <b>${esc(k.file)}</b> (${megabytes(k.size)}). When it is done, load it with "Load a kit file". ` +
      `If nothing started, <a href="${esc(k.url)}" target="_blank" rel="noopener">download it here</a>.`
    return
  }
  box.textContent = `Downloading the ${name} kit (${megabytes(k.size)})…`
  try {
    const bytes = await host.download(k.url)
    const { name: stored } = await putKit(bytes)
    state.kitsByStore[stored] = await readKit(bytes)
    log(`the ${stored} kit, downloaded from engine ${rel.tag}`)
    await probeKits()
  } catch (e) { box.innerHTML = `<span class="problem">The ${esc(name)} kit could not be downloaded: ${esc(e.message)}</span>` }
}

// A kit by its store name: this session, the kit store, or bundled.
async function kitByName (name, want) {
  if (state.kitsByStore[name]) return state.kitsByStore[name]
  let bytes = await getKitBytes(name)
  if (bytes) log(`the ${name} kit, from the kit store`)
  else {
    log(`fetching the ${name} kit`)
    const r = await fetch(`${host.kitsBase}${name}.zip`, { cache: 'no-store' })
    if (!r.ok) throw new Error(`no ${name} kit (download it under Platform, or load one with "Load a kit file")`)
    bytes = new Uint8Array(await r.arrayBuffer())
  }
  const kit = await readKit(bytes, want)
  state.kitsByStore[name] = kit
  return kit
}
const kitFor = (target) => {
  const t = TARGETS.find((x) => x.id === target)
  return kitByName(t.store, t.kitType ?? target)
}

$('pick-kit').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]
  ev.target.value = ''
  if (!f) return
  try {
    $('kit-summary').textContent = 'Reading the kit…'
    const bytes = new Uint8Array(await f.arrayBuffer())
    // Kept in the kit store, so it is there for every later build, offline.
    const { name, info } = await putKit(bytes)
    state.kitsByStore[name] = await readKit(bytes)
    // A Tauri kit selects the Tauri shell and its platform; any other kit, its target.
    const t = TARGETS.find((x) => x.store === name || x.tauri === name)
    if (info.kit === 'tauri') setShell('tauri')
    else if (t?.desktop) setShell('electron')
    if (t) state.target = t.id
    await probeKits()
    drawIcon()
  } catch (e) { $('kit-summary').innerHTML = `<span class="problem">${esc(e.message)}</span>` }
  refresh()
})

function setShell (v) {
  state.shell = v === 'tauri' ? 'tauri' : 'electron'
  try { localStorage.setItem('packager:shell', state.shell) } catch {}
  drawTargets()
  refresh()
}
$('shell').addEventListener('change', (e) => setShell(e.target.value))

// ---- key ------------------------------------------------------------------------------

async function showKey () {
  if (!state.identity) {
    $('key-status').innerHTML = 'No key yet. Make one, or restore a backup.'
  } else {
    const fp = await fingerprint(state.identity.certificate)
    $('key-status').innerHTML = `<span class="ok">Key ready</span> — ${esc(state.identity.commonName)}, made ${state.identity.created.slice(0, 10)}<div class="fp">SHA-256 ${fp}</div>`
  }
  $('key-backup').disabled = !state.identity
  refresh()
}

$('key-new').addEventListener('click', async () => {
  if (state.identity && !confirm('Replace the current key? Games signed with it can then no longer be updated from this browser unless you restore its backup.')) return
  $('key-status').textContent = 'Making a key…'
  state.identity = await newIdentity($('label').value || 'Digidream game')
  showKey()
})
$('key-backup').addEventListener('click', () => {
  save(new Blob([backupJson(state.identity)], { type: 'application/json' }), 'digidream-signing-key.json')
})
$('key-restore').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]
  ev.target.value = ''
  if (!f) return
  try { state.identity = await restoreJson(await f.text()); showKey() } catch (e) { $('key-status').innerHTML = `<span class="problem">${esc(e.message)}</span>` }
})

// ---- what is missing --------------------------------------------------------------------

function missing () {
  const t = TARGETS.find((x) => x.id === state.target)
  if (!state.module) return 'Open a module.'
  const p = packagingProblem(state.module)
  if (p) return `This module cannot be packaged: ${p}.`
  if (!available(t)) {
    if (t.why) return `${t.name}: ${t.why}.`
    const lacking = kitsNeeded(t).filter((n) => !hasKit(n))
    return `${t.name}${usesTauri(t) ? ' (Tauri)' : ''}: no ${lacking.join(' or ')} kit; load one.`
  }
  if (!$('label').value.trim()) return 'Give the game a name.'
  if (t.id === 'windows') {
    const bad = windowsPathProblems(state.module)
    if (bad.length) return `Windows cannot hold ${bad.length} of this module's file names, e.g. ${bad.slice(0, 2).join(', ')}.`
  }
  if (t.desktop && !t.mac) return null
  const pp = packageIdProblem($('pkg').value.trim())
  if (t.mac) return pp ? `Bundle id: ${pp}.` : null
  if (pp) return `Package id: ${pp}.`
  const vc = Number($('vcode').value)
  if (!Number.isInteger(vc) || vc < 1 || vc > 2100000000) return 'The version code is a whole number from 1.'
  if (!state.identity) return 'Make or restore a signing key.'
  return null
}

function refresh () {
  const tg = TARGETS.find((t) => t.id === state.target)
  $('shell-row').classList.toggle('hidden', !tg?.desktop)
  $('shell').value = state.shell
  // The Tauri runner is game only: no studio file calls (yet).
  $('studio').disabled = usesTauri(tg)
  if (usesTauri(tg)) $('studio').value = '0'
  // Nor a log file yet (the runner has no GameLog).
  $('logfile').disabled = usesTauri(tg)
  if (usesTauri(tg)) $('logfile').value = '0'
  document.body.classList.toggle('desktop', !!tg?.desktop)
  document.body.classList.toggle('mac', !!tg?.mac)
  const why = missing()
  $('build').disabled = !!why
  $('build-why').textContent = why ?? ''
  const pp = state.module ? packageIdProblem($('pkg').value.trim()) : null
  $('details-problem').textContent = pp ?? ''
  const k = state.kitsByStore[usesTauri(tg) ? tg.tauri : tg?.store]
  $('kit-summary').textContent = k ? `Kit: engine ${k.info.engine}, built ${k.info.built.slice(0, 10)}, ${k.info.abi ?? `Electron ${k.info.electron}`}` : ''
}
for (const id of ['label', 'pkg', 'vname', 'vcode', 'map', 'studio', 'logfile']) $(id).addEventListener('input', refresh)

// ---- build ------------------------------------------------------------------------------

$('build').addEventListener('click', async () => {
  $('build').disabled = true
  $('download').classList.add('hidden')
  $('install').classList.add('hidden')
  $('log').textContent = ''
  const t0 = performance.now()
  try {
    const tgt = TARGETS.find((t) => t.id === state.target)
    const kit = usesTauri(tgt) ? await kitByName(tgt.tauri, 'tauri') : await kitFor(state.target)
    log(`kit: engine ${kit.info.engine}, built ${kit.info.built}`)
    const picture = state.picture
    const common = {
      label: $('label').value.trim(),
      studio: $('studio').value === '1',
      log: $('logfile').value === '1'
    }
    let blob, name
    if (state.target === 'android') {
      const opts = {
        ...common,
        packageId: $('pkg').value.trim(),
        versionName: $('vname').value.trim() || '1.0',
        versionCode: Number($('vcode').value),
        map: $('map').value,
        identity: state.identity,
        icon: picture ? await adaptiveIcon(picture) : null
      }
      const apk = await buildApk(kit, state.module, opts, log)
      blob = new Blob([apk], { type: 'application/vnd.android.package-archive' })
      name = `${state.module.id}-${opts.versionName}.apk`
      remember(state.module.id, { ...remembered(state.module.id), label: opts.label, packageId: opts.packageId, versionName: opts.versionName, versionCode: opts.versionCode, map: opts.map, studio: opts.studio, log: opts.log })
    } else if (usesTauri(TARGETS.find((t) => t.id === state.target))) {
      const tg = TARGETS.find((t) => t.id === state.target)
      const tkit = await kitByName(tg.tauri, 'tauri')
      const akit = await kitByName('android', 'android')
      const opts = {
        ...common,
        bundleId: $('pkg').value.trim(),
        version: $('vname').value.trim() || '1.0',
        iconFor: picture ? (n) => (tg.mac ? macIcon(picture, n) : squareIcon(picture, n)) : undefined
      }
      ;({ blob, filename: name } = await buildTauri(tkit, akit, state.module, opts, log))
      remember(state.module.id, { ...remembered(state.module.id), label: opts.label, packageId: opts.bundleId, versionName: opts.version, log: opts.log })
    } else if (TARGETS.find((t) => t.id === state.target)?.mac) {
      const opts = {
        ...common,
        bundleId: $('pkg').value.trim(),
        version: $('vname').value.trim() || '1.0',
        iconFor: picture ? (n) => macIcon(picture, n) : undefined
      }
      ;({ blob, filename: name } = await buildMac(kit, state.module, opts, log))
      remember(state.module.id, { ...remembered(state.module.id), label: opts.label, packageId: opts.bundleId, versionName: opts.version, studio: opts.studio, log: opts.log })
    } else {
      const opts = {
        ...common,
        version: $('vname').value.trim() || '1.0',
        iconFor: picture ? (n) => squareIcon(picture, n) : undefined
      }
      ;({ blob, filename: name } = await buildDesktop(kit, state.module, opts, log))
      remember(state.module.id, { ...remembered(state.module.id), label: opts.label, versionName: opts.version, studio: opts.studio, log: opts.log })
    }
    if (state.output) URL.revokeObjectURL(state.output)
    state.output = URL.createObjectURL(blob)
    $('download').href = state.output
    $('download').download = name
    state.outputBlob = blob
    state.outputName = name
    $('download').textContent = `${host.kind === 'browser' ? 'Download' : 'Save'} ${name} (${mb(blob.size)})`
    $('download').classList.remove('hidden')
    if (host.canInstall && name.endsWith('.apk')) $('install').classList.remove('hidden')
    log(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${name}`)
  } catch (e) {
    log(`FAILED: ${e.message}`)
    console.error(e)
  }
  refresh()
})

function save (blob, name) {
  return host.save(blob, name)
}

// In a browser the link downloads by itself; an app shell saves through its host.
$('download').addEventListener('click', async (ev) => {
  if (host.kind === 'browser') return
  ev.preventDefault()
  try { log(`saved: ${await host.save(state.outputBlob, state.outputName)}`) } catch (e) { log(`not saved: ${e.message}`) }
})
$('install').addEventListener('click', async () => {
  try { log(await host.install(state.outputBlob, state.outputName)) } catch (e) { log(`not installed: ${e.message}`) }
})

function esc (s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

if (!window.isSecureContext || !crypto.subtle) {
  $('key-status').innerHTML = '<span class="problem">This page needs a secure context (https, or 127.0.0.1) to sign.</span>'
} else {
  state.identity = await loadIdentity().catch(() => null)
  showKey()
}
drawTargets()
probeKits()
