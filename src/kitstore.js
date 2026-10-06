// Where kits are kept: the Origin Private File System, a folder that belongs to
// the page. Chrome, Edge, Firefox, Safari 17, Electron and Android's WebView all
// have it, so the browser page, the desktop app and the phone app keep kits the
// same way -- loaded once (a file the user picks, or one bundled with the
// tool), then there for every build, offline.
//
// A kit is stored under its kit.json identity: <kit>[-<arch>].zip, plus a small
// <name>.json with kit.json's summary, so listing kits does not mean opening
// 150 MB zips.

import { readKit } from './kit.js'

export const kitName = (info) => (info.kit === 'macos' ? `macos-${info.arch}` : info.kit)

async function dir () {
  if (!navigator.storage?.getDirectory) throw new Error('this browser has no private file storage (OPFS)')
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle('kits', { create: true })
}

/** [{ name, info }] for every stored kit. */
export async function listKits () {
  const out = []
  try {
    const d = await dir()
    for await (const [n, h] of d.entries()) {
      if (h.kind !== 'file' || !n.endsWith('.json')) continue
      try { out.push({ name: n.slice(0, -5), info: JSON.parse(await (await h.getFile()).text()) }) } catch {}
    }
  } catch {}
  return out
}

/** Store kit bytes (after checking they ARE a kit). Returns { name, info }. */
export async function putKit (bytes) {
  const { info } = await readKit(bytes)
  const name = kitName(info)
  const d = await dir()
  const write = async (file, data) => {
    const w = await (await d.getFileHandle(file, { create: true })).createWritable()
    await w.write(data)
    await w.close()
  }
  const { files, ...summary } = info
  await write(`${name}.zip`, bytes)
  await write(`${name}.json`, JSON.stringify(summary))
  return { name, info }
}

/** The stored kit's bytes, or null. */
export async function getKitBytes (name) {
  try {
    const d = await dir()
    const f = await (await d.getFileHandle(`${name}.zip`)).getFile()
    return new Uint8Array(await f.arrayBuffer())
  } catch { return null }
}

export async function removeKit (name) {
  const d = await dir()
  for (const f of [`${name}.zip`, `${name}.json`]) await d.removeEntry(f).catch(() => {})
}
