// A macOS .icns, from PNGs. The format is a container: 'icns' and its length,
// then (type, length, PNG) records, every number big-endian. Each type names a
// size; the @2x ones are what a Retina screen shows.

const TYPES = [
  ['icp4', 16], ['ic11', 32], ['icp5', 32], ['ic12', 64], ['ic07', 128],
  ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]
]

/** pngFor(size) -> PNG bytes. Returns the .icns bytes. */
export async function makeIcns (pngFor) {
  const cache = new Map()
  const parts = []
  for (const [type, size] of TYPES) {
    if (!cache.has(size)) cache.set(size, await pngFor(size))
    const png = cache.get(size)
    const rec = new Uint8Array(8 + png.length)
    rec.set(new TextEncoder().encode(type), 0)
    new DataView(rec.buffer).setUint32(4, rec.length)
    rec.set(png, 8)
    parts.push(rec)
  }
  const len = 8 + parts.reduce((a, b) => a + b.length, 0)
  const out = new Uint8Array(len)
  out.set(new TextEncoder().encode('icns'), 0)
  new DataView(out.buffer).setUint32(4, len)
  let o = 8
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
