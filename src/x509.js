// A self-signed X.509 certificate, built with WebCrypto and a little DER.
//
// An APK's signature carries the signer's certificate, and Android identifies
// an app by it: an update must be signed by the same certificate or the phone
// refuses it. Nobody verifies the chain -- it is self-signed by design, as
// every Android debug and upload key is -- so what matters is only that it is
// well-formed DER and that it outlives the game (Google Play asks for validity
// past 2033; this gives 30 years).

const enc = new TextEncoder()

function len (n) {
  if (n < 0x80) return [n]
  const b = []
  while (n > 0) { b.unshift(n & 0xff); n >>>= 8 }
  return [0x80 | b.length, ...b]
}
export function tlv (tag, content) {
  const c = content instanceof Uint8Array ? content : Uint8Array.from(content)
  return Uint8Array.from([tag, ...len(c.length), ...c])
}
const cat = (...xs) => {
  const out = new Uint8Array(xs.reduce((a, b) => a + b.length, 0))
  let o = 0
  for (const x of xs) { out.set(x, o); o += x.length }
  return out
}
export const seq = (...xs) => tlv(0x30, cat(...xs))
const set = (...xs) => tlv(0x31, cat(...xs))
const nul = () => Uint8Array.from([0x05, 0x00])
const utf8str = (s) => tlv(0x0c, enc.encode(s))
const bitString = (bytes) => tlv(0x03, cat(Uint8Array.from([0]), bytes))
const explicit = (n, x) => tlv(0xa0 | n, x)

/** An unsigned big-endian integer, with the sign byte DER needs. */
function integer (bytes) {
  let b = bytes
  while (b.length > 1 && b[0] === 0 && b[1] < 0x80) b = b.subarray(1)
  if (b[0] & 0x80) b = cat(Uint8Array.from([0]), b)
  return tlv(0x02, b)
}

function oid (dotted) {
  const parts = dotted.split('.').map(Number)
  const out = [parts[0] * 40 + parts[1]]
  for (const p of parts.slice(2)) {
    const b = []
    let v = p
    do { b.unshift(v & 0x7f); v = Math.floor(v / 128) } while (v > 0)
    for (let i = 0; i < b.length - 1; i++) b[i] |= 0x80
    out.push(...b)
  }
  return tlv(0x06, out)
}

// UTCTime until 2049, GeneralizedTime from 2050 -- RFC 5280's rule.
function time (d) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const y = d.getUTCFullYear()
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  return y < 2050 ? tlv(0x17, enc.encode(`${p(y % 100)}${rest}`)) : tlv(0x18, enc.encode(`${p(y, 4)}${rest}`))
}

const SHA256_RSA = seq(oid('1.2.840.113549.1.1.11'), nul())
export const RSA_PARAMS = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }

function name (cn, org) {
  const rdn = (o, v) => set(seq(oid(o), utf8str(v)))
  return seq(rdn('2.5.4.3', cn), ...(org ? [rdn('2.5.4.10', org)] : []))
}

/**
 * A new signing identity: an RSA-3072 key pair (extractable, so it can be
 * backed up -- a lost key is a game that can never be updated) and a
 * self-signed certificate for it.
 */
export async function createIdentity ({ commonName, organization, years = 30 } = {}) {
  const keys = await crypto.subtle.generateKey(
    { ...RSA_PARAMS, modulusLength: 3072, publicExponent: Uint8Array.from([1, 0, 1]) },
    true, ['sign', 'verify'])
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey))
  const serial = crypto.getRandomValues(new Uint8Array(16))
  serial[0] &= 0x7f
  const now = new Date()
  const until = new Date(now)
  until.setUTCFullYear(until.getUTCFullYear() + years)
  const subject = name(commonName || 'Digidream game', organization)
  const tbs = seq(
    explicit(0, integer(Uint8Array.from([2]))), // v3
    integer(serial),
    SHA256_RSA,
    subject,
    seq(time(now), time(until)),
    subject,
    spki
  )
  const sig = new Uint8Array(await crypto.subtle.sign(RSA_PARAMS, keys.privateKey, tbs))
  const certificate = seq(tbs, SHA256_RSA, bitString(sig))
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey))
  return { certificate, spki, pkcs8, privateKey: keys.privateKey, created: now.toISOString(), commonName: commonName || 'Digidream game' }
}

/** Re-create the CryptoKey of an identity loaded from storage or a backup file. */
export async function importIdentity ({ pkcs8, spki, certificate, created, commonName }) {
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, RSA_PARAMS, true, ['sign'])
  return { pkcs8, spki, certificate, created, commonName, privateKey }
}

/** SHA-256 of the certificate, as `apksigner verify --print-certs` shows it. */
export async function fingerprint (certificate) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', certificate))
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join(':')
}
