// The signing identity, kept in the browser.
//
// Android ties an app to the certificate that signed it: a new version signed
// with a different key will not install over the old one. So the key is made
// once, kept (IndexedDB, in this browser's profile), and must be BACKED UP --
// the page says so, and offers the file. A backup is JSON holding the private
// key in the clear; it is the user's to guard, as a keystore file would be.

import { createIdentity, importIdentity } from './x509.js'
import { get, put } from './store.js'

const KEY = 'android'

const b64 = (u8) => btoa(String.fromCharCode(...u8))
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

function serialise (id) {
  return { pkcs8: id.pkcs8, spki: id.spki, certificate: id.certificate, created: id.created, commonName: id.commonName }
}

/** The saved identity, or null. */
export async function loadIdentity () {
  const rec = await get('keys', KEY)
  return rec ? importIdentity(rec) : null
}

export async function newIdentity (commonName) {
  const id = await createIdentity({ commonName })
  await put('keys', KEY, serialise(id))
  return id
}

export function backupJson (id) {
  return JSON.stringify({
    kind: 'digidream-packager-key',
    version: 1,
    commonName: id.commonName,
    created: id.created,
    pkcs8: b64(id.pkcs8),
    spki: b64(id.spki),
    certificate: b64(id.certificate)
  }, null, 2)
}

export async function restoreJson (text) {
  const j = JSON.parse(text)
  if (j.kind !== 'digidream-packager-key') throw new Error('not a packager key backup')
  const rec = { pkcs8: unb64(j.pkcs8), spki: unb64(j.spki), certificate: unb64(j.certificate), created: j.created, commonName: j.commonName }
  const id = await importIdentity(rec) // proves the key parses before it replaces anything
  await put('keys', KEY, rec)
  return id
}
