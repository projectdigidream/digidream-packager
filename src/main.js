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
import { readKit } from './kit.js'
import { loadIdentity, newIdentity, backupJson, restoreJson } from './keys.js'
import { fingerprint } from './x509.js'
import { adaptiveIcon, squareIcon, macIcon } from './icon.js'
import { get as dbGet, put as dbPut, del as dbDel } from './store.js'

const $ = (id) => document.getElementById(id)

// Every platform the packager knows, whether or not a kit exists for it yet.
// `why` is what is shown while it cannot be built.
const TARGETS = [
  { id: 'android', name: 'Android', out: 'APK, arm64', kit: 'android.zip' },
  { id: 'linux', name: 'Linux', out: 'x86-64, .tar.gz', kit: 'linux.zip', desktop: true },
  { id: 'windows', name: 'Windows', out: 'x86-64, .zip', kit: 'windows.zip', desktop: true },
  { id: 'macos', name: 'macOS', out: 'Apple silicon, .zip', kit: 'macos-arm64.zip', kitType: 'macos', desktop: true, mac: true },
  { id: 'macos-x64', name: 'macOS (Intel)', out: 'x86-64, .zip', kit: 'macos-x64.zip', kitType: 'macos', desktop: true, mac: true },
  { id: 'ios', name: 'iOS', out: 'app', kit: null, why: 'later' }
]

const state = {
  module: null,
  target: 'android',
  kits: {}, // target id -> { info, zip }
  kitAvailable: {}, // target id -> true when a kit file sits beside the page
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
    if (saved?.map && m.maps.includes(saved.map)) $('map').value = saved.map
    // Game only unless asked: the studio is for making, and a module carrying
    // a studio document is still usually being shipped to players.
    $('studio').value = saved?.studio ? '1' : '0'
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

function drawTargets () {
  $('targets').innerHTML = TARGETS.map((t) => {
    const have = state.kits[t.id] || state.kitAvailable[t.id]
    const sub = have ? t.out : (t.why ?? 'no kit')
    return `<button class="target" data-id="${t.id}" aria-pressed="${state.target === t.id}">
      <b>${t.name}</b><small>${esc(sub)}</small></button>`
  }).join('')
  for (const b of $('targets').querySelectorAll('.target')) {
    b.addEventListener('click', () => { state.target = b.dataset.id; drawTargets(); drawIcon(); refresh() })
  }
}

async function probeKits () {
  await Promise.all(TARGETS.filter((t) => t.kit).map(async (t) => {
    try {
      const r = await fetch(`build/kits/${t.kit}`, { method: 'HEAD', cache: 'no-store' })
      state.kitAvailable[t.id] = r.ok
    } catch { state.kitAvailable[t.id] = false }
  }))
  drawTargets()
  refresh()
}

async function kitFor (target) {
  if (state.kits[target]) return state.kits[target]
  const t = TARGETS.find((x) => x.id === target)
  log(`fetching the ${t.name} kit`)
  const r = await fetch(`build/kits/${t.kit}`, { cache: 'no-store' })
  if (!r.ok) throw new Error(`no ${t.name} kit beside this page (${r.status})`)
  const kit = await readKit(new Uint8Array(await r.arrayBuffer()), t.kitType ?? target)
  state.kits[target] = kit
  return kit
}

$('pick-kit').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]
  ev.target.value = ''
  if (!f) return
  try {
    const kit = await readKit(new Uint8Array(await f.arrayBuffer()))
    // The macOS kits are one kind in two arches; the arch picks the target.
    const id = kit.info.kit === 'macos' && kit.info.arch === 'x64' ? 'macos-x64' : kit.info.kit
    state.kits[id] = kit
    state.target = id
    drawTargets()
  } catch (e) { $('kit-summary').innerHTML = `<span class="problem">${esc(e.message)}</span>` }
  refresh()
})

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
  if (!state.kits[t.id] && !state.kitAvailable[t.id]) return `${t.name}: ${t.why ?? 'no kit beside this page; load one'}.`
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
  document.body.classList.toggle('desktop', !!tg?.desktop)
  document.body.classList.toggle('mac', !!tg?.mac)
  const why = missing()
  $('build').disabled = !!why
  $('build-why').textContent = why ?? ''
  const pp = state.module ? packageIdProblem($('pkg').value.trim()) : null
  $('details-problem').textContent = pp ?? ''
  const k = state.kits[state.target]
  $('kit-summary').textContent = k ? `Kit: engine ${k.info.engine}, built ${k.info.built.slice(0, 10)}, ${k.info.abi ?? `Electron ${k.info.electron}`}` : ''
}
for (const id of ['label', 'pkg', 'vname', 'vcode', 'map', 'studio']) $(id).addEventListener('input', refresh)

// ---- build ------------------------------------------------------------------------------

$('build').addEventListener('click', async () => {
  $('build').disabled = true
  $('download').classList.add('hidden')
  $('log').textContent = ''
  const t0 = performance.now()
  try {
    const kit = await kitFor(state.target)
    log(`kit: engine ${kit.info.engine}, built ${kit.info.built}`)
    const picture = state.picture
    const common = {
      label: $('label').value.trim(),
      studio: $('studio').value === '1'
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
      remember(state.module.id, { ...remembered(state.module.id), label: opts.label, packageId: opts.packageId, versionName: opts.versionName, versionCode: opts.versionCode, map: opts.map, studio: opts.studio })
    } else if (TARGETS.find((t) => t.id === state.target)?.mac) {
      const opts = {
        ...common,
        bundleId: $('pkg').value.trim(),
        version: $('vname').value.trim() || '1.0',
        iconFor: picture ? (n) => macIcon(picture, n) : undefined
      }
      ;({ blob, filename: name } = await buildMac(kit, state.module, opts, log))
      remember(state.module.id, { ...remembered(state.module.id), label: opts.label, packageId: opts.bundleId, versionName: opts.version, studio: opts.studio })
    } else {
      const opts = {
        ...common,
        version: $('vname').value.trim() || '1.0',
        iconFor: picture ? (n) => squareIcon(picture, n) : undefined
      }
      ;({ blob, filename: name } = await buildDesktop(kit, state.module, opts, log))
      remember(state.module.id, { ...remembered(state.module.id), label: opts.label, versionName: opts.version, studio: opts.studio })
    }
    if (state.output) URL.revokeObjectURL(state.output)
    state.output = URL.createObjectURL(blob)
    $('download').href = state.output
    $('download').download = name
    $('download').textContent = `Download ${name} (${mb(blob.size)})`
    $('download').classList.remove('hidden')
    log(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${name}`)
  } catch (e) {
    log(`FAILED: ${e.message}`)
    console.error(e)
  }
  refresh()
})

function save (blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}

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
