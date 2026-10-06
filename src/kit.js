// A kit: the engine's binaries for one platform, as packager/scripts/
// build_kits.sh writes them -- a zip with kit.json at its root.

import { readZip } from './zip.js'

export const KITS = ['android', 'linux', 'windows', 'macos', 'tauri']

export async function readKit (bytes, want) {
  const zip = readZip(bytes)
  const meta = zip.get('kit.json')
  if (!meta) throw new Error('not a packager kit (no kit.json)')
  const info = JSON.parse(new TextDecoder().decode(await meta.bytes()))
  if (!KITS.includes(info.kit)) throw new Error(`unknown kit '${info.kit}'`)
  if (want && info.kit !== want) throw new Error(`this is the ${info.kit} kit, not the ${want} one`)
  return { info, zip }
}
