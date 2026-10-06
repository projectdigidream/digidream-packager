// A Windows executable's icon, replaced in the page.
//
// What rcedit does for electron-builder, without Windows: the icon a .exe
// shows in Explorer and on the taskbar is a resource inside it -- an
// RT_GROUP_ICON directory naming RT_ICON images by id, each found through a
// data entry holding its address (an RVA) and size. The address may point
// anywhere in the image, so the new images go into a NEW SECTION appended to
// the file, and only the entries and the group directory are edited in place.
// Nothing existing moves, so no other address in the file needs fixing.
// (Writing them into the old images' slots was the first idea; Electron's
// 256 px slot is 19 KB, and a detailed picture is several times that as PNG.)
//
// Images are PNG, which Windows has read inside icons since Vista. If the file
// carries an Authenticode signature it no longer matches once a byte changes,
// and an invalid signature reads worse than none, so it is removed. The PE
// checksum is left alone: Windows checks it only for drivers.

const RT_ICON = 3
const RT_GROUP_ICON = 14

function layout (u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  if (dv.getUint16(0, true) !== 0x5a4d) throw new Error('not a Windows executable (no MZ)')
  const pe = dv.getUint32(0x3c, true)
  if (dv.getUint32(pe, true) !== 0x00004550) throw new Error('not a PE file')
  const sections = dv.getUint16(pe + 6, true)
  const optSize = dv.getUint16(pe + 20, true)
  const opt = pe + 24
  const magic = dv.getUint16(opt, true)
  const dirs = opt + (magic === 0x20b ? 112 : 96)
  const sectTable = opt + optSize
  const secs = []
  for (let i = 0; i < sections; i++) {
    const s = sectTable + i * 40
    secs.push({ va: dv.getUint32(s + 12, true), vsize: dv.getUint32(s + 8, true), raw: dv.getUint32(s + 20, true), rawSize: dv.getUint32(s + 16, true) })
  }
  const fileOffset = (rva) => {
    const s = secs.find((x) => rva >= x.va && rva < x.va + Math.max(x.vsize, x.rawSize))
    if (!s) throw new Error(`RVA ${rva.toString(16)} is in no section`)
    return rva - s.va + s.raw
  }
  return { dv, dirs, fileOffset }
}

/** The resource tree's leaves: [{ type, id, lang, entryAt (file offset of the data entry), rva, size }]. */
function resources (u8) {
  const { dv, dirs, fileOffset } = layout(u8)
  const rsrcRva = dv.getUint32(dirs + 2 * 8, true)
  if (!rsrcRva) return []
  const base = fileOffset(rsrcRva)
  const out = []
  const walk = (dirOff, path) => {
    const named = dv.getUint16(dirOff + 12, true)
    const ids = dv.getUint16(dirOff + 14, true)
    for (let i = 0; i < named + ids; i++) {
      const e = dirOff + 16 + i * 8
      const name = dv.getUint32(e, true)
      const off = dv.getUint32(e + 4, true)
      const key = name & 0x80000000 ? `name@${name & 0x7fffffff}` : name
      if (off & 0x80000000) walk(base + (off & 0x7fffffff), [...path, key])
      else out.push({ type: path[0], id: path[1], lang: key, entryAt: base + off, rva: dv.getUint32(base + off, true), size: dv.getUint32(base + off + 4, true) })
    }
  }
  walk(base, [])
  return out
}

/** The executable's main icon group: { group, images: [{ id, width, height, size }] } or null. */
export function iconGroup (exe) {
  const res = resources(exe)
  const { fileOffset } = layout(exe)
  const group = res.find((r) => r.type === RT_GROUP_ICON)
  if (!group) return null
  const g = fileOffset(group.rva)
  const dv = new DataView(exe.buffer, exe.byteOffset, exe.byteLength)
  const count = dv.getUint16(g + 4, true)
  const images = []
  for (let i = 0; i < count; i++) {
    const e = g + 6 + i * 14
    images.push({ width: exe[e] || 256, height: exe[e + 1] || 256, size: dv.getUint32(e + 8, true), id: dv.getUint16(e + 12, true) })
  }
  return { group, images }
}

const align = (n, a) => Math.ceil(n / a) * a

/**
 * Replace the main icon. pngFor(size) -> PNG bytes for a square icon of that
 * many pixels, called once per size the executable's group lists. Returns
 * { bytes, sizes } -- a NEW array; `exeIn` is not modified.
 */
export async function replaceIcon (exeIn, pngFor) {
  const res = resources(exeIn)
  const info = iconGroup(exeIn)
  if (!info) throw new Error('the executable has no icon to replace')

  // The images, 8-aligned one after another: the new section's contents.
  const images = []
  let len = 0
  for (const img of info.images) {
    const leaf = res.find((r) => r.type === RT_ICON && r.id === img.id)
    if (!leaf) throw new Error(`icon image ${img.id} is missing from the resources`)
    const png = await pngFor(img.width)
    images.push({ img, leaf, png, at: len })
    len = align(len + png.length, 8)
  }

  // The headers: one more section after the last one, in memory and on disk.
  const { dv: dv0 } = layout(exeIn)
  const pe = dv0.getUint32(0x3c, true)
  const nsec = dv0.getUint16(pe + 6, true)
  const opt = pe + 24
  const sectAlign = dv0.getUint32(opt + 32, true)
  const fileAlign = dv0.getUint32(opt + 36, true)
  const imageSize = dv0.getUint32(opt + 56, true)
  const headersSize = dv0.getUint32(opt + 60, true)
  const dirs = opt + (dv0.getUint16(opt, true) === 0x20b ? 112 : 96)
  const newHeader = opt + dv0.getUint16(pe + 20, true) + nsec * 40
  if (newHeader + 40 > headersSize || exeIn.subarray(newHeader, newHeader + 40).some((b) => b !== 0)) {
    throw new Error('no room in the executable for another section header')
  }

  // The certificate table, if any, sits at the end of the file; it goes, and
  // the new section takes its place.
  const certAt = dv0.getUint32(dirs + 4 * 8, true)
  const certSize = dv0.getUint32(dirs + 4 * 8 + 4, true)
  let end = exeIn.length
  if (certAt && certSize && certAt + certSize === exeIn.length) end = certAt
  const rawAt = align(end, fileAlign)
  const rawSize = align(len, fileAlign)
  const va = align(imageSize, sectAlign)

  const exe = new Uint8Array(rawAt + rawSize)
  exe.set(exeIn.subarray(0, end), 0)
  const dv = new DataView(exe.buffer)
  if (certAt && certSize) { dv.setUint32(dirs + 4 * 8, 0, true); dv.setUint32(dirs + 4 * 8 + 4, 0, true) }

  exe.set(new TextEncoder().encode('.icons'), newHeader)
  dv.setUint32(newHeader + 8, len, true) // VirtualSize
  dv.setUint32(newHeader + 12, va, true) // VirtualAddress
  dv.setUint32(newHeader + 16, rawSize, true) // SizeOfRawData
  dv.setUint32(newHeader + 20, rawAt, true) // PointerToRawData
  dv.setUint32(newHeader + 36, 0x40000040, true) // initialised data, readable
  dv.setUint16(pe + 6, nsec + 1, true)
  dv.setUint32(opt + 56, va + align(len, sectAlign), true) // SizeOfImage
  dv.setUint32(opt + 8, dv.getUint32(opt + 8, true) + rawSize, true) // SizeOfInitializedData

  for (const { leaf, png, at } of images) {
    exe.set(png, rawAt + at)
    dv.setUint32(leaf.entryAt, va + at, true) // OffsetToData (an RVA)
    dv.setUint32(leaf.entryAt + 4, png.length, true)
  }
  // The group directory, rewritten in place: same entries, new sizes.
  const g = layout(exe).fileOffset(info.group.rva)
  images.forEach(({ img, png }, i) => {
    const e = g + 6 + i * 14
    exe[e] = img.width >= 256 ? 0 : img.width
    exe[e + 1] = img.height >= 256 ? 0 : img.height
    exe[e + 2] = 0 // colours: 0 = more than 256
    exe[e + 3] = 0
    dv.setUint16(e + 4, 1, true) // planes
    dv.setUint16(e + 6, 32, true) // bits per pixel
    dv.setUint32(e + 8, png.length, true)
  })
  return { bytes: exe, sizes: info.images.map((i) => i.width) }
}
