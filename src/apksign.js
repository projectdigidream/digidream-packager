// APK Signature Scheme v2, in the browser.
//
// What apksigner does for an APK whose minSdk is 24 or more: v2 alone is what
// the platform verifies there (the old JAR signature is only for older phones,
// and the engine's APK asks for 26). The scheme, from
// source.android.com/docs/security/features/apksigning/v2:
//
//   [zip entries][APK Signing Block][central directory][end of central dir]
//
// The signature covers the three zip sections, digested in 1 MiB chunks, with
// the end record's central-directory offset taken as it is BEFORE the block is
// inserted -- which is simply the unsigned file. So: digest the unsigned zip,
// build the block, splice it in before the central directory, and move the end
// record's offset along by the block's length.

import { RSA_PARAMS } from './x509.js'

const SIG_RSA_PKCS1_SHA256 = 0x0103
const V2_BLOCK_ID = 0x7109871a
const CHUNK = 1 << 20
const MAGIC = new TextEncoder().encode('APK Sig Block 42')

const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b }
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b }
const cat = (...xs) => {
  const out = new Uint8Array(xs.reduce((a, b) => a + b.length, 0))
  let o = 0
  for (const x of xs) { out.set(x, o); o += x.length }
  return out
}
// Everything in the block is length-prefixed with a u32.
const lp = (...xs) => { const body = cat(...xs); return cat(u32(body.length), body) }
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))

function zipLayout (apk) {
  const dv = new DataView(apk.buffer, apk.byteOffset, apk.byteLength)
  let eocd = -1
  for (let i = apk.length - 22; i >= Math.max(0, apk.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('apksign: not a zip')
  const cdOffset = dv.getUint32(eocd + 16, true)
  const cdSize = dv.getUint32(eocd + 12, true)
  if (cdOffset + cdSize !== eocd) throw new Error('apksign: the central directory does not end where the end record starts')
  // An APK that already has a signing block would be signed twice over.
  if (cdOffset >= 16 && new TextDecoder().decode(apk.subarray(cdOffset - 16, cdOffset)) === 'APK Sig Block 42') {
    throw new Error('apksign: already signed')
  }
  return { cdOffset, eocd }
}

async function chunkedDigest (sections) {
  const digests = []
  for (const s of sections) {
    for (let o = 0; o < s.length; o += CHUNK) {
      const c = s.subarray(o, Math.min(s.length, o + CHUNK))
      digests.push(await sha256(cat(Uint8Array.of(0xa5), u32(c.length), c)))
    }
  }
  return sha256(cat(Uint8Array.of(0x5a), u32(digests.length), ...digests))
}

/**
 * Sign an unsigned, aligned APK. `identity` is { privateKey, certificate, spki }
 * (see x509.js). Returns the signed bytes.
 */
export async function signApkV2 (apk, identity) {
  const { cdOffset, eocd } = zipLayout(apk)
  const entries = apk.subarray(0, cdOffset)
  const cd = apk.subarray(cdOffset, eocd)
  const end = apk.subarray(eocd)

  const digest = await chunkedDigest([entries, cd, end])
  const signedData = cat(
    lp(lp(u32(SIG_RSA_PKCS1_SHA256), lp(digest))), // digests
    lp(lp(identity.certificate)), // certificates
    lp() // additional attributes: none
  )
  const signature = new Uint8Array(await crypto.subtle.sign(RSA_PARAMS, identity.privateKey, signedData))
  const signer = cat(
    lp(signedData),
    lp(lp(u32(SIG_RSA_PKCS1_SHA256), lp(signature))),
    lp(identity.spki)
  )
  const value = lp(lp(signer)) // signers: a sequence of one

  // The block: u64 size, ID-value pairs (each u64 length, u32 id, value),
  // u64 size again, magic. "size" excludes the first size field itself.
  const pair = cat(u64(4 + value.length), u32(V2_BLOCK_ID), value)
  const size = pair.length + 8 + 16
  const block = cat(u64(size), pair, u64(size), MAGIC)

  const newEnd = end.slice()
  new DataView(newEnd.buffer).setUint32(16, cdOffset + block.length, true)
  return cat(entries, block, cd, newEnd)
}
