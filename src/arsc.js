// The resource table (resources.arsc), edited where a game needs it to differ.
//
// One edit, today: the paths of file resources live in the table's GLOBAL
// string pool, and Android chooses how to load a drawable by the extension of
// that path -- ".xml" is parsed as XML, ".png" decoded as a bitmap. So a game's
// own icon is the kit's icon resource pointed at a PNG instead of the engine's
// vector: replace the string, ship the file, and no resource ids move.
//
// Layout (ResTable_header): { u16 type=2, u16 headerSize=12, u32 size,
// u32 packageCount }, then the global string pool chunk, then the packages.
// Nothing outside the pool points into it by offset, so a pool of a different
// length only changes the table's total size.

import { readPool, encodePool } from './axml.js'

export function replaceTableStrings (arsc, replace) {
  const dv = new DataView(arsc.buffer, arsc.byteOffset, arsc.byteLength)
  if (dv.getUint16(0, true) !== 0x0002) throw new Error('arsc: not a resource table')
  const hsize = dv.getUint16(2, true)
  const at = hsize
  if (dv.getUint16(at, true) !== 0x0001) throw new Error('arsc: no global string pool after the header')
  const poolSize = dv.getUint32(at + 4, true)
  if (dv.getUint32(at + 12, true) !== 0) throw new Error('arsc: the global pool has styles; not handled')
  const { strings, utf8 } = readPool(dv, arsc, at)
  let changed = 0
  const next = strings.map((s) => {
    const r = replace(s)
    if (r !== undefined && r !== s) { changed++; return r }
    return s
  })
  if (!changed) return { bytes: arsc, changed }
  const pool = encodePool(next, utf8)
  const rest = arsc.subarray(at + poolSize)
  const out = new Uint8Array(hsize + pool.length + rest.length)
  out.set(arsc.subarray(0, hsize), 0)
  out.set(pool, hsize)
  out.set(rest, hsize + pool.length)
  new DataView(out.buffer).setUint32(4, out.length, true)
  return { bytes: out, changed }
}
