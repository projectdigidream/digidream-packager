// Android's binary XML (the compiled AndroidManifest.xml), decoded and encoded.
//
// This is the part of aapt2 a game actually needs. The kit carries the
// manifest aapt2 compiled from engine/shells/android/AndroidManifest.xml; a
// game differs from it in three values -- the package, the label, the version
// -- so the packager decodes it, edits those, and encodes it again. The
// manifest's source of truth stays the engine's.
//
// The format, as frameworks/base/libs/androidfw/ResourceTypes.h defines it:
// chunks of { u16 type, u16 headerSize, u32 size }. An XML document is one
// chunk holding a STRING POOL, a RESOURCE MAP (string index -> attribute
// resource id, for the first N strings), and then a flat stream of
// namespace-start, element-start, element-end and namespace-end chunks.
//
// Two rules the encoder must keep or the platform misreads the file:
//   - every attribute name that has a resource id is one of the FIRST strings
//     of the pool, in the order of the resource map;
//   - an element's attributes are sorted by resource id (the parser binary-
//     searches them), attributes without one after.

const RES_STRING_POOL = 0x0001
const RES_XML = 0x0003
const RES_XML_START_NAMESPACE = 0x0100
const RES_XML_END_NAMESPACE = 0x0101
const RES_XML_START_ELEMENT = 0x0102
const RES_XML_END_ELEMENT = 0x0103
const RES_XML_CDATA = 0x0104
const RES_XML_RESOURCE_MAP = 0x0180

const UTF8_FLAG = 1 << 8
const NO_INDEX = 0xffffffff

export const TYPE = { NULL: 0x00, REFERENCE: 0x01, STRING: 0x03, INT_DEC: 0x10, INT_HEX: 0x11, BOOLEAN: 0x12 }
export const ANDROID_NS = 'http://schemas.android.com/apk/res/android'

// ---- decode -----------------------------------------------------------------

export function readPool (dv, u8, at) {
  const count = dv.getUint32(at + 8, true)
  const flags = dv.getUint32(at + 16, true)
  const stringsStart = dv.getUint32(at + 20, true)
  const headerSize = dv.getUint16(at + 2, true)
  const utf8 = (flags & UTF8_FLAG) !== 0
  const strings = []
  for (let i = 0; i < count; i++) {
    let p = at + stringsStart + dv.getUint32(at + headerSize + i * 4, true)
    if (utf8) {
      // char length then byte length, each 1 or 2 bytes (high bit = 2 bytes)
      let n = u8[p++]; if (n & 0x80) p++
      let len = u8[p++]; if (len & 0x80) len = ((len & 0x7f) << 8) | u8[p++]
      strings.push(new TextDecoder().decode(u8.subarray(p, p + len)))
    } else {
      let len = dv.getUint16(p, true); p += 2
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | dv.getUint16(p, true); p += 2 }
      let s = ''
      for (let k = 0; k < len; k++) s += String.fromCharCode(dv.getUint16(p + k * 2, true))
      strings.push(s)
    }
  }
  return { strings, utf8 }
}

/**
 * Decode to a flat list of nodes, strings resolved:
 *   { kind: 'ns-start'|'ns-end', prefix, uri, line }
 *   { kind: 'start', ns, name, line, attrs: [{ ns, name, resId, type, data, value }] }
 *   { kind: 'end', ns, name, line }
 * `value` is the string for STRING attributes; `data` is the raw 32-bit value
 * for the rest.
 */
export function decodeAxml (bytes) {
  const u8 = bytes
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  if (dv.getUint16(0, true) !== RES_XML) throw new Error('axml: not a binary XML document')
  let strings = []
  let utf8 = false
  let resMap = []
  const nodes = []
  const str = (i) => (i === NO_INDEX ? null : strings[i])
  let p = dv.getUint16(2, true)
  while (p < u8.length) {
    const type = dv.getUint16(p, true)
    const hsize = dv.getUint16(p + 2, true)
    const size = dv.getUint32(p + 4, true)
    if (type === RES_STRING_POOL) {
      ({ strings, utf8 } = readPool(dv, u8, p))
    } else if (type === RES_XML_RESOURCE_MAP) {
      resMap = []
      for (let q = p + hsize; q < p + size; q += 4) resMap.push(dv.getUint32(q, true))
    } else if (type === RES_XML_START_NAMESPACE || type === RES_XML_END_NAMESPACE) {
      nodes.push({
        kind: type === RES_XML_START_NAMESPACE ? 'ns-start' : 'ns-end',
        line: dv.getUint32(p + 8, true),
        prefix: str(dv.getUint32(p + hsize, true)),
        uri: str(dv.getUint32(p + hsize + 4, true))
      })
    } else if (type === RES_XML_START_ELEMENT) {
      const b = p + hsize
      const attrStart = dv.getUint16(b + 8, true)
      const attrSize = dv.getUint16(b + 10, true)
      const attrCount = dv.getUint16(b + 12, true)
      const attrs = []
      for (let i = 0; i < attrCount; i++) {
        const a = b + attrStart + i * attrSize
        const nameIdx = dv.getUint32(a + 4, true)
        const type = u8[a + 15]
        const data = dv.getUint32(a + 16, true)
        attrs.push({
          ns: str(dv.getUint32(a, true)),
          name: strings[nameIdx],
          resId: nameIdx < resMap.length ? resMap[nameIdx] : 0,
          type,
          data,
          value: type === TYPE.STRING ? strings[data] : undefined
        })
      }
      nodes.push({ kind: 'start', line: dv.getUint32(p + 8, true), ns: str(dv.getUint32(b, true)), name: strings[dv.getUint32(b + 4, true)], attrs })
    } else if (type === RES_XML_END_ELEMENT) {
      nodes.push({ kind: 'end', line: dv.getUint32(p + 8, true), ns: str(dv.getUint32(p + hsize, true)), name: strings[dv.getUint32(p + hsize + 4, true)] })
    } else if (type === RES_XML_CDATA) {
      throw new Error('axml: CDATA is not expected in a manifest')
    }
    p += size
  }
  return { nodes, utf8 }
}

// ---- encode -----------------------------------------------------------------

function chunkHeader (type, headerSize, size) {
  const h = new Uint8Array(8)
  const v = new DataView(h.buffer)
  v.setUint16(0, type, true)
  v.setUint16(2, headerSize, true)
  v.setUint32(4, size, true)
  return h
}

function pad4 (n) { return (4 - (n % 4)) % 4 }

export function encodePool (strings, utf8) {
  const bodies = strings.map((s) => {
    if (utf8) {
      const b = new TextEncoder().encode(s)
      const len = (n) => (n > 0x7f ? [0x80 | (n >> 8), n & 0xff] : [n])
      return Uint8Array.from([...len(s.length), ...len(b.length), ...b, 0])
    }
    const out = new Uint8Array(2 + s.length * 2 + 2)
    const v = new DataView(out.buffer)
    if (s.length > 0x7fff) throw new Error('axml: string too long')
    v.setUint16(0, s.length, true)
    for (let i = 0; i < s.length; i++) v.setUint16(2 + i * 2, s.charCodeAt(i), true)
    return out
  })
  const headerSize = 28
  const offsetsSize = strings.length * 4
  let dataSize = bodies.reduce((a, b) => a + b.length, 0)
  const tail = pad4(dataSize)
  dataSize += tail
  const size = headerSize + offsetsSize + dataSize
  const out = new Uint8Array(size)
  const v = new DataView(out.buffer)
  out.set(chunkHeader(RES_STRING_POOL, headerSize, size), 0)
  v.setUint32(8, strings.length, true)
  v.setUint32(12, 0, true) // styles
  v.setUint32(16, utf8 ? UTF8_FLAG : 0, true)
  v.setUint32(20, headerSize + offsetsSize, true)
  v.setUint32(24, 0, true)
  let o = 0
  bodies.forEach((b, i) => {
    v.setUint32(headerSize + i * 4, o, true)
    out.set(b, headerSize + offsetsSize + o)
    o += b.length
  })
  return out
}

/** Sort an element's attributes as the platform needs: by resource id, then the rest. */
export function sortAttrs (attrs) {
  const withId = attrs.filter((a) => a.resId).sort((a, b) => a.resId - b.resId)
  return [...withId, ...attrs.filter((a) => !a.resId)]
}

export function encodeAxml ({ nodes, utf8 = false }) {
  // Strings: first every attribute name that has a resource id (one entry per
  // distinct (name, id)), in resource-id order; then everything else.
  const resNames = new Map() // name -> resId
  for (const n of nodes) {
    if (n.kind !== 'start') continue
    for (const a of n.attrs) {
      if (!a.resId) continue
      const had = resNames.get(a.name)
      if (had !== undefined && had !== a.resId) throw new Error(`axml: '${a.name}' has two resource ids`)
      resNames.set(a.name, a.resId)
    }
  }
  const strings = [...resNames.entries()].sort((a, b) => a[1] - b[1]).map(([s]) => s)
  const resIds = strings.map((s) => resNames.get(s))
  const index = new Map(strings.map((s, i) => [s, i]))
  // A plain-string copy of a resource-named attribute's name (e.g. "name" used
  // as an element name too) can share the index; the platform only consults
  // the resource map for attribute names.
  const idx = (s) => {
    if (s === null || s === undefined) return NO_INDEX
    if (!index.has(s)) { index.set(s, strings.length); strings.push(s) }
    return index.get(s)
  }
  const chunks = []
  for (const n of nodes) {
    if (n.kind === 'ns-start' || n.kind === 'ns-end') {
      const c = new Uint8Array(24)
      const v = new DataView(c.buffer)
      c.set(chunkHeader(n.kind === 'ns-start' ? RES_XML_START_NAMESPACE : RES_XML_END_NAMESPACE, 16, 24), 0)
      v.setUint32(8, n.line ?? 0, true)
      v.setUint32(12, NO_INDEX, true)
      v.setUint32(16, idx(n.prefix), true)
      v.setUint32(20, idx(n.uri), true)
      chunks.push(c)
    } else if (n.kind === 'start') {
      const attrs = sortAttrs(n.attrs)
      const size = 16 + 20 + attrs.length * 20
      const c = new Uint8Array(size)
      const v = new DataView(c.buffer)
      c.set(chunkHeader(RES_XML_START_ELEMENT, 16, size), 0)
      v.setUint32(8, n.line ?? 0, true)
      v.setUint32(12, NO_INDEX, true)
      v.setUint32(16, idx(n.ns), true)
      v.setUint32(20, idx(n.name), true)
      v.setUint16(24, 20, true) // attributeStart
      v.setUint16(26, 20, true) // attributeSize
      v.setUint16(28, attrs.length, true)
      const at = (pred) => attrs.findIndex(pred) + 1
      v.setUint16(30, at((a) => a.resId === 0x010100d0), true) // android:id
      v.setUint16(32, at((a) => !a.ns && a.name === 'class'), true)
      v.setUint16(34, at((a) => !a.ns && a.name === 'style'), true)
      attrs.forEach((a, i) => {
        const o = 36 + i * 20
        v.setUint32(o, idx(a.ns), true)
        v.setUint32(o + 4, idx(a.name), true)
        if (a.type === TYPE.STRING) {
          const s = idx(a.value)
          v.setUint32(o + 8, s, true) // raw value
          v.setUint16(o + 12, 8, true)
          c[o + 15] = TYPE.STRING
          v.setUint32(o + 16, s, true)
        } else {
          v.setUint32(o + 8, NO_INDEX, true)
          v.setUint16(o + 12, 8, true)
          c[o + 15] = a.type
          v.setUint32(o + 16, a.data >>> 0, true)
        }
      })
      chunks.push(c)
    } else if (n.kind === 'end') {
      const c = new Uint8Array(24)
      const v = new DataView(c.buffer)
      c.set(chunkHeader(RES_XML_END_ELEMENT, 16, 24), 0)
      v.setUint32(8, n.line ?? 0, true)
      v.setUint32(12, NO_INDEX, true)
      v.setUint32(16, idx(n.ns), true)
      v.setUint32(20, idx(n.name), true)
      chunks.push(c)
    }
  }
  const pool = encodePool(strings, utf8)
  const map = new Uint8Array(8 + resIds.length * 4)
  map.set(chunkHeader(RES_XML_RESOURCE_MAP, 8, map.length), 0)
  const mv = new DataView(map.buffer)
  resIds.forEach((id, i) => mv.setUint32(8 + i * 4, id, true))
  const body = [pool, map, ...chunks]
  const size = 8 + body.reduce((a, b) => a + b.length, 0)
  const out = new Uint8Array(size)
  out.set(chunkHeader(RES_XML, 8, size), 0)
  let o = 8
  for (const b of body) { out.set(b, o); o += b.length }
  return out
}

// ---- editing helpers ---------------------------------------------------------

export function findElement (doc, name) {
  return doc.nodes.find((n) => n.kind === 'start' && n.name === name)
}

/** Set (or add) an attribute. `value` is a string for STRING, a number otherwise. */
export function setAttr (el, { ns = null, name, resId = 0, type, value }) {
  let a = el.attrs.find((x) => x.name === name && (x.ns ?? null) === ns)
  if (!a) { a = { ns, name, resId }; el.attrs.push(a) }
  a.resId = resId || a.resId
  a.type = type
  if (type === TYPE.STRING) { a.value = value; a.data = 0 } else { a.value = undefined; a.data = value >>> 0 }
  return a
}
