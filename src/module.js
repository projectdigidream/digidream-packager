// A module, as the packager holds it: its files by path relative to the module
// root, read lazily, plus what module.txt and maps/ say about it.
//
// It arrives one of two ways, and both put the module in a folder named after
// its id: a folder picked in the page (<input webkitdirectory> paths are
// "doom2/maps/map01.dnpm"), or the studio's export (docs/STUDIO.md: "a zip of
// the module root", entries under "<id>/..."). The folder name IS the id -- the
// server and build_apk.sh both take it from there, not from module.txt.

import { readZip } from './zip.js'

/** files: [{ path, size, read: () => Promise<Uint8Array> }] with paths "<id>/..." */
export async function moduleFromEntries (files) {
  const tops = new Set(files.map((f) => f.path.split('/')[0]))
  if (tops.size !== 1) {
    throw new Error(`expected one module folder, found ${tops.size}: ${[...tops].slice(0, 5).join(', ')}`)
  }
  const id = [...tops][0]
  const map = new Map()
  for (const f of files) {
    const rel = f.path.slice(id.length + 1)
    if (!rel || rel.split('/').some((s) => s === '.DS_Store' || s === '..')) continue
    map.set(rel, f)
  }
  return describe(id, map)
}

/** From a browser FileList (webkitdirectory). */
export function moduleFromFileList (list) {
  return moduleFromEntries([...list].map((file) => ({
    path: file.webkitRelativePath || file.name,
    size: file.size,
    read: async () => new Uint8Array(await file.arrayBuffer())
  })))
}

/** From a zip (the studio's export pack). */
export function moduleFromZip (bytes) {
  const z = readZip(bytes)
  return moduleFromEntries([...z.values()].map((e) => ({ path: e.name, size: e.size, read: () => e.bytes() })))
}

async function describe (id, files) {
  const text = files.has('module.txt') ? new TextDecoder().decode(await files.get('module.txt').read()) : ''
  const field = (k) => text.split('\n').map((l) => l.trim()).find((l) => l.startsWith(k + ' '))?.slice(k.length + 1).trim()
  const about = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('about ')).map((l) => l.slice(6)).join(' ')
  // Top-level maps/*.dnpm only: what build_apk.sh ships to the page and what
  // the server loads when it is not given --map.
  const maps = [...files.keys()].filter((p) => /^maps\/[^/]+\.dnpm$/.test(p)).map((p) => p.slice(5)).sort()
  const sourceMaps = [...files.keys()].filter((p) => /^maps\/[^/]+\.map$/.test(p)).map((p) => p.slice(5)).sort()
  const bytes = [...files.values()].reduce((a, f) => a + (f.size || 0), 0)
  // The map the module starts on, when the studio's document names one
  // (its Settings, "starting map"): the map choice starts there.
  let start = null
  if (files.has('module.studio.json')) {
    try { const sm = JSON.parse(new TextDecoder().decode(await files.get('module.studio.json').read())).startMap; if (sm && maps.includes(`${sm}.dnpm`)) start = `${sm}.dnpm` } catch {}
  }
  return {
    id,
    files,
    name: field('name') || id,
    about,
    controls: field('controls') || null,
    maps,
    start,
    sourceMaps,
    bytes,
    hasModuleTxt: files.has('module.txt'),
    studio: files.has('module.studio.json')
  }
}

/** Why this module cannot be packaged on its own, or null. */
export function packagingProblem (mod) {
  if (mod.maps.length === 0) {
    return mod.sourceMaps.length
      ? `no baked maps: ${mod.sourceMaps.length} .map file(s) in maps/ but no .dnpm -- bake them first`
      : 'no maps: maps/ has no .dnpm (a module.txt-only add-on needs the module it adds to)'
  }
  return null
}
