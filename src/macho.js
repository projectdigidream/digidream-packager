// Ad-hoc code signing of a macOS app's main executable, in the page.
//
// WHY. On Apple Silicon every executable must carry a valid signature, and a
// downloaded app is judged as a BUNDLE: its main executable's signature must
// bind the Info.plist and a seal of every resource (_CodeSignature/
// CodeResources). Electron's own build is only linker-signed -- `codesign
// --verify --deep --strict` rejects it as it ships -- and a game edits
// Info.plist and adds its files in any case. An app whose seal does not hold is
// "damaged and can't be opened", with no way round it short of a terminal; an
// app correctly signed ad hoc gets the ordinary "Apple could not verify it"
// prompt, which System Settings > Privacy & Security > "Open Anyway" passes.
//
// WHAT. Exactly what `codesign -s -` writes for a bundle's main executable, as
// that tool was read doing it (packager/README.md): a SuperBlob holding
//   - a CodeDirectory v0x20400, SHA-256, flags adhoc, three
//     special slots (Info.plist, requirements, CodeResources), the identifier,
//     and the exec segment of __TEXT;
//   - an empty requirement set (count 0) -- an ad-hoc signature's designated
//     requirement is its cdhash;
//   - an empty CMS wrapper.
// Nested code (frameworks, helper apps) is signed once in the kit by the real
// codesign and only referenced here, by cdhash, in CodeResources (macos.js).
//
// All code-signing structures are BIG-endian; the Mach-O around them is little.

const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))
const LC_SEGMENT_64 = 0x19
const LC_CODE_SIGNATURE = 0x1d
const align = (n, a) => Math.ceil(n / a) * a

function parse (u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  if (dv.getUint32(0, true) !== 0xfeedfacf) throw new Error('not a thin 64-bit Mach-O (fat binaries are not handled)')
  const cputype = dv.getUint32(4, true)
  const filetype = dv.getUint32(12, true)
  const ncmds = dv.getUint32(16, true)
  let p = 32
  const segs = {}
  let sig = null
  for (let i = 0; i < ncmds; i++) {
    const cmd = dv.getUint32(p, true)
    const size = dv.getUint32(p + 4, true)
    if (cmd === LC_SEGMENT_64) {
      const name = new TextDecoder().decode(u8.subarray(p + 8, p + 24)).replace(/\0+$/, '')
      segs[name] = { at: p, fileoff: Number(dv.getBigUint64(p + 40, true)), filesize: Number(dv.getBigUint64(p + 48, true)) }
    } else if (cmd === LC_CODE_SIGNATURE) {
      sig = { at: p, dataoff: dv.getUint32(p + 8, true), datasize: dv.getUint32(p + 12, true) }
    }
    p += size
  }
  if (!sig) throw new Error('the executable has no LC_CODE_SIGNATURE to fill')
  if (!segs.__LINKEDIT || !segs.__TEXT) throw new Error('the executable has no __TEXT or __LINKEDIT')
  // The page size codesign hashes by is the CPU's: 16 KiB on arm64, 4 KiB on
  // x86-64. (4 KiB everywhere was the first guess; the arm64 CodeDirectory then
  // differed from codesign's in exactly that field.)
  const pageLog2 = cputype === 0x0100000c ? 14 : 12
  return { dv, filetype, segs, sig, pageLog2 }
}

const be32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b }
const cat = (...xs) => {
  const out = new Uint8Array(xs.reduce((a, b) => a + b.length, 0))
  let o = 0
  for (const x of xs) { out.set(x, o); o += x.length }
  return out
}

export const EMPTY_REQUIREMENTS = cat(be32(0xfade0c01), be32(12), be32(0))
const EMPTY_CMS = cat(be32(0xfade0b01), be32(8))

/**
 * Sign `exe` (a thin Mach-O) ad hoc as the main executable of a bundle.
 * special: { infoPlist: Uint8Array, codeResources: Uint8Array }
 * Returns { bytes, cdhash } -- cdhash is the 20-byte truncated SHA-256.
 */
export async function signMain (exeIn, identifier, special) {
  const { segs, sig, pageLog2, filetype } = parse(exeIn)
  const PAGE = 1 << pageLog2
  const codeLimit = sig.dataoff
  const nCode = Math.ceil(codeLimit / PAGE)
  const ident = new TextEncoder().encode(identifier + '\0')
  const nSpecial = 3
  const hdr = 88
  const hashOffset = hdr + ident.length + nSpecial * 32
  const cdLen = hashOffset + nCode * 32
  const sigLen = 12 + 3 * 8 + cdLen + EMPTY_REQUIREMENTS.length + EMPTY_CMS.length
  // Room for the signature: grow it if the old one was smaller. It is the last
  // thing in the file, so growing it moves nothing; __LINKEDIT and the load
  // command are told, and since they are in page 0 they are edited BEFORE the
  // pages are hashed.
  const datasize = Math.max(sig.datasize, align(sigLen, 16))
  const exe = new Uint8Array(sig.dataoff + datasize)
  exe.set(exeIn.subarray(0, sig.dataoff), 0)
  const dv = new DataView(exe.buffer)
  dv.setUint32(sig.at + 12, datasize, true)
  const le = segs.__LINKEDIT
  const leSize = sig.dataoff + datasize - le.fileoff
  dv.setBigUint64(le.at + 48, BigInt(leSize), true) // filesize
  const vm = Number(dv.getBigUint64(le.at + 32, true))
  dv.setBigUint64(le.at + 32, BigInt(Math.max(vm, align(leSize, 0x4000))), true) // vmsize

  const cd = new Uint8Array(cdLen)
  const c = new DataView(cd.buffer)
  c.setUint32(0, 0xfade0c02); c.setUint32(4, cdLen); c.setUint32(8, 0x20400)
  c.setUint32(12, 0x2) // adhoc
  c.setUint32(16, hashOffset); c.setUint32(20, hdr)
  c.setUint32(24, nSpecial); c.setUint32(28, nCode); c.setUint32(32, codeLimit)
  cd[36] = 32; cd[37] = 2; cd[38] = 0; cd[39] = pageLog2 // hash size, SHA-256, platform, log2(page)
  c.setBigUint64(64, BigInt(segs.__TEXT.fileoff))
  c.setBigUint64(72, BigInt(segs.__TEXT.filesize))
  c.setBigUint64(80, BigInt(filetype === 2 ? 1 : 0)) // CS_EXECSEG_MAIN_BINARY for MH_EXECUTE
  cd.set(ident, hdr)
  // Special slots sit just below the code hashes, slot -1 nearest.
  const slot = (n, h) => cd.set(h, hashOffset - n * 32)
  slot(1, await sha256(special.infoPlist))
  slot(2, await sha256(EMPTY_REQUIREMENTS))
  slot(3, await sha256(special.codeResources))
  for (let i = 0; i < nCode; i++) {
    cd.set(await sha256(exe.subarray(i * PAGE, Math.min(codeLimit, (i + 1) * PAGE))), hashOffset + i * 32)
  }

  const blobs = [[0, cd], [2, EMPTY_REQUIREMENTS], [0x10000, EMPTY_CMS]]
  const head = new Uint8Array(12 + blobs.length * 8)
  const h = new DataView(head.buffer)
  h.setUint32(0, 0xfade0cc0); h.setUint32(4, sigLen); h.setUint32(8, blobs.length)
  let off = head.length
  blobs.forEach(([type, b], i) => { h.setUint32(12 + i * 8, type); h.setUint32(16 + i * 8, off); off += b.length })
  exe.set(cat(head, ...blobs.map(([, b]) => b)), sig.dataoff)
  return { bytes: exe, cdhash: (await sha256(cd)).subarray(0, 20) }
}
