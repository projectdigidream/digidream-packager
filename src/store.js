// The packager's own storage in this browser (IndexedDB): the signing key and
// each module's icon. Per browser profile, which is why the key has a backup.

const DB = 'digidream-packager'
const STORES = ['keys', 'icons']

function open () {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 2)
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s)
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

async function tx (store, mode, fn) {
  const db = await open()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode)
    const req = fn(t.objectStore(store))
    t.oncomplete = () => resolve(req?.result)
    t.onerror = () => reject(t.error)
  })
}

export const get = (store, key) => tx(store, 'readonly', (s) => s.get(key))
export const put = (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key))
export const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key))
