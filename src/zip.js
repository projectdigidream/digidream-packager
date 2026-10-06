// Zip, read and written in the browser (and in node, which the tests use).
//
// Only what an APK and a kit need: stored and deflated entries, UTF-8 names,
// no zip64 (a kit or a game over 4 GB is not a thing this has to survive), and
// ALIGNMENT -- Android maps some entries straight out of the archive, so their
// data has to start on a boundary (resources.arsc on 4 bytes since target SDK
// 30, or the install is refused). That is zipalign's whole job, done here as
// the entries are laid down rather than as a second pass.
//
// Deflate is the platform's (CompressionStream 'deflate-raw'): no library, and
// the same code in a page and in node 22.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32 (bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function pipe (bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream))
  return new Uint8Array(await out.arrayBuffer())
}
export const deflateRaw = (bytes) => pipe(bytes, new CompressionStream('deflate-raw'))
export const inflateRaw = (bytes) => pipe(bytes, new DecompressionStream('deflate-raw'))

const utf8 = new TextEncoder()
const utf8d = new TextDecoder()

/**
 * Read an archive's central directory. Returns a Map of name -> entry, where
 * entry.bytes() inflates on demand -- a kit is tens of megabytes and most of a
 * game's entries are copied, so nothing is inflated that is not asked for.
 */
export function readZip (buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  // The end record is the last thing in the file, followed by a comment of at
  // most 64 KB; search backwards for its signature.
  let eocd = -1
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const entries = new Map()
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error(`zip: bad central directory entry ${n}`)
    const method = dv.getUint16(p + 10, true)
    const crc = dv.getUint32(p + 16, true)
    const csize = dv.getUint32(p + 20, true)
    const size = dv.getUint32(p + 24, true)
    const nlen = dv.getUint16(p + 28, true)
    const xlen = dv.getUint16(p + 30, true)
    const clen = dv.getUint16(p + 32, true)
    const madeBy = dv.getUint16(p + 4, true) >> 8
    const external = dv.getUint32(p + 38, true)
    const local = dv.getUint32(p + 42, true)
    const name = utf8d.decode(u8.subarray(p + 46, p + 46 + nlen))
    p += 46 + nlen + xlen + clen
    if (name.endsWith('/')) continue
    // The LOCAL header's name and extra lengths, which may differ from the
    // central ones (an aligned entry's padding lives in the local extra only).
    const lnlen = dv.getUint16(local + 26, true)
    const lxlen = dv.getUint16(local + 28, true)
    const start = local + 30 + lnlen + lxlen
    const raw = u8.subarray(start, start + csize)
    if (method !== 0 && method !== 8) throw new Error(`zip: ${name} uses method ${method}`)
    entries.set(name, {
      name, method, crc, size,
      // The unix mode, when a unix zip wrote it (host 3): how the desktop kits
      // carry their executables' x bits. Null otherwise.
      mode: madeBy === 3 ? (external >>> 16) & 0xffff : null,
      raw,
      async bytes () {
        const b = method === 0 ? raw : await inflateRaw(raw)
        if (b.length !== size) throw new Error(`zip: ${name} inflated to ${b.length} bytes, expected ${size}`)
        return b
      }
    })
  }
  return entries
}

/**
 * Write an archive.
 *
 * entries: [{ name, data: Uint8Array, compress?: boolean, align?: number,
 *             raw?: { method, crc, data } }]
 * `raw` copies an already-compressed entry out of another archive without
 * inflating and deflating it again, which for a kit's 30 MB is most of the
 * time a build would otherwise spend.
 *
 * Timestamps are a fixed 1980-01-01: the same inputs give the same bytes,
 * which is what lets a test compare two builds, and a phone does not care.
 */
export async function writeZip (entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const name = utf8.encode(e.name)
    let method, crc, data, size
    if (e.raw) {
      ({ method, crc, data } = e.raw)
      size = e.raw.size
    } else {
      size = e.data.length
      crc = crc32(e.data)
      if (e.compress) {
        const d = await deflateRaw(e.data)
        // Deflate can lose on data that is already compressed; store it then.
        if (d.length < e.data.length) { method = 8; data = d } else { method = 0; data = e.data }
      } else { method = 0; data = e.data }
    }
    // Alignment padding, as zipalign writes it: extra field 0xD935 holding the
    // alignment, then zeros. Only stored data can be mapped, so only stored
    // entries are aligned.
    let extra = new Uint8Array(0)
    const align = method === 0 ? (e.align ?? 0) : 0
    if (align > 1) {
      const base = offset + 30 + name.length
      let pad = (align - (base % align)) % align
      if (pad !== 0) {
        while (pad < 6) pad += align
        extra = new Uint8Array(pad)
        const xv = new DataView(extra.buffer)
        xv.setUint16(0, 0xd935, true)
        xv.setUint16(2, pad - 4, true)
        xv.setUint16(4, align, true)
      }
    }
    const lh = new Uint8Array(30)
    const lv = new DataView(lh.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, method === 8 ? 20 : 10, true)
    lv.setUint16(6, 0x0800, true) // names are UTF-8
    lv.setUint16(8, method, true)
    lv.setUint16(10, 0, true) // 00:00
    lv.setUint16(12, (0 << 9) | (1 << 5) | 1, true) // 1980-01-01
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, extra.length, true)
    parts.push(lh, name, extra, data)

    const ch = new Uint8Array(46)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 0x031e, true) // made by: unix, 3.0
    cv.setUint16(6, method === 8 ? 20 : 10, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, method, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, (0 << 9) | (1 << 5) | 1, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, name.length, true)
    // external attributes: a regular file, rw-r--r--, or rwxr-xr-x when asked
    cv.setUint32(38, ((e.mode ?? 0o100644) << 16) >>> 0, true)
    cv.setUint32(42, offset, true)
    central.push(ch, name)

    offset += 30 + name.length + extra.length + data.length
  }
  const cdStart = offset
  const cdSize = central.reduce((a, b) => a + b.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, cdStart, true)
  return concat([...parts, ...central, end])
}

export function concat (chunks) {
  const n = chunks.reduce((a, b) => a + b.length, 0)
  const out = new Uint8Array(n)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}
