// What the packager reads of a module (src/module.js): its maps, and the map
// it starts on when the studio's document names one.
//
//   node packager/test/module.test.js

import { moduleFromEntries } from '../src/module.js'

let fails = 0
const check = (ok, what) => { if (!ok) { fails++; console.log(`  FAIL ${what}`) } else console.log(`  ok   ${what}`) }
const enc = (s) => new TextEncoder().encode(s)
const entry = (path, text) => ({ path, size: text.length, read: async () => enc(text) })
const mod = (startMap) => moduleFromEntries([
  entry('demo/module.txt', 'name Demo\n'),
  entry('demo/maps/alpha.dnpm', 'x'), entry('demo/maps/zeta.dnpm', 'x'),
  ...(startMap === undefined ? [] : [entry('demo/module.studio.json', JSON.stringify({ id: 'demo', startMap }))])
])

const named = await mod('zeta')
check(named.start === 'zeta.dnpm' && named.maps.join() === 'alpha.dnpm,zeta.dnpm', `the studio's starting map is the start (${named.start})`)
check((await mod(undefined)).start === null, 'CONTROL: no studio document, no start (the first by name is the page\'s default)')
check((await mod('gone')).start === null, 'CONTROL: a starting map the module does not have is no start')

console.log(`\nmodule: ${fails} failures`)
process.exit(fails ? 1 : 0)
