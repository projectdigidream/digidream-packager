// Where kits come from: the engine's releases (src/releases.js).
//
//   node packager/test/releases.test.js
//
// The release JSON read into kits by store name (pure), and -- when the network
// is there -- the real latest engine release carries a kit for every platform
// the page offers, under the names the kit store uses.

import { kitsOf, releaseKits } from '../src/releases.js'

let fails = 0
const check = (ok, what) => { if (!ok) { fails++; console.log(`  FAIL ${what}`) } else console.log(`  ok   ${what}`) }

const STORE = ['android', 'linux', 'windows', 'macos-arm64', 'macos-x64', 'tauri-linux', 'tauri-windows', 'tauri-macos-arm64', 'tauri-macos-x64']

const fake = {
  tag_name: 'v9.9.9',
  assets: [
    { name: 'digidream-engine-9.9.9-kit-macos-arm64.zip', size: 3, browser_download_url: 'https://x/a' },
    { name: 'digidream-engine-9.9.9-kit-tauri-linux.zip', size: 4, browser_download_url: 'https://x/b' },
    { name: 'digidream-engine-9.9.9-source.tar.gz', size: 5, browser_download_url: 'https://x/c' }
  ]
}
const got = kitsOf(fake)
check(got.tag === 'v9.9.9' && Object.keys(got.kits).sort().join() === 'macos-arm64,tauri-linux' && got.kits['macos-arm64'].url === 'https://x/a',
      `kits are read by store name, other assets ignored (${Object.keys(got.kits)})`)
check(Object.keys(kitsOf({ tag_name: 'v0', assets: [] }).kits).length === 0, 'a release without kits has none (control)')

let live = null
try { live = await releaseKits() } catch (e) { console.log(`  (the engine's releases could not be read: ${e.message}; the live check is skipped)`) }
if (live) {
  const missing = STORE.filter((n) => !live.kits[n])
  check(missing.length === 0, `the latest engine release (${live.tag}) has every kit the page offers${missing.length ? `; missing ${missing}` : ''}`)
  check(Object.values(live.kits).every((k) => /^https:\/\/github\.com\/projectdigidream\/digidream-engine\/releases\/download\//.test(k.url)),
        'every kit URL is one the desktop app agrees to download')
}

console.log(`\nreleases: ${fails} failures`)
process.exit(fails ? 1 : 0)
