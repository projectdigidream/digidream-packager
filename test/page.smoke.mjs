// The page, driven as a user drives it, at a phone's size.
//
//   cd <dir with puppeteer-core@23 installed>
//   node /abs/path/packager/test/page.smoke.mjs <module.zip> <outdir>
//
// Needs `node packager/serve.js` running (127.0.0.1:8950) and a kit in
// packager/build/kits/. puppeteer-core is not a dependency of this repo, so it
// runs from a scratch directory that has it (the midisynth tests do the same).
// Writes <outdir>/page.apk (the downloaded game) and <outdir>/page-*.png.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// Resolved from the WORKING directory, where it is installed -- an ES import
// would look beside this file, in the repo, where it deliberately is not.
const puppeteer = createRequire(join(process.cwd(), 'x.js'))('puppeteer-core')

const [zip, outdir] = process.argv.slice(2)
if (!zip || !outdir) { console.error('usage: page.smoke.mjs <module.zip> <outdir>'); process.exit(2) }
const URL_ = process.env.PACKAGER_URL ?? 'http://127.0.0.1:8950/'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

let fails = 0
const check = (ok, what) => { if (!ok) { fails++; console.log(`  FAIL ${what}`) } else console.log(`  ok   ${what}`) }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--mute-audio'] })
try {
  const page = await browser.newPage()
  // A phone: 412 x 915 CSS px, touch, 2.6 dpr (a Pixel 7).
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(URL_, { waitUntil: 'networkidle0' })

  // A fresh profile has no key: Build must say so rather than fail later.
  await page.waitForFunction(() => document.getElementById('key-status').textContent.includes('No key'))
  check(await page.$eval('#build', (b) => b.disabled), 'Build is disabled before a module is opened')
  check((await page.$eval('#build-why', (e) => e.textContent)).includes('Open a module'), 'and it says why')

  const input = await page.$('#pick-zip')
  await input.uploadFile(zip)
  await page.waitForFunction(() => /level\(s\)/.test(document.getElementById('mod-summary').textContent), { timeout: 30000 })
  const summary = await page.$eval('#mod-summary', (e) => e.textContent)
  check(/level\(s\)/.test(summary), `module read: ${summary.split('—')[0].trim()}`)
  check((await page.$eval('#build-why', (e) => e.textContent)).includes('signing key'), 'with a module, the key is what is missing')

  await page.click('#key-new')
  await page.waitForFunction(() => document.getElementById('key-status').textContent.includes('Key ready'), { timeout: 60000 })
  check(!(await page.$eval('#build', (b) => b.disabled)), 'Build is enabled once module and key are there')

  // CONTROL: a bad package id disables Build again, with the reason.
  await page.$eval('#pkg', (e) => { e.value = 'nodots'; e.dispatchEvent(new Event('input')) })
  check(await page.$eval('#build', (b) => b.disabled), 'CONTROL: a one-segment package id disables Build')
  await page.$eval('#pkg', (e) => { e.value = 'com.digidream.pagetest'; e.dispatchEvent(new Event('input')) })

  // An icon: composed in the page (OffscreenCanvas) into the 432 px layer.
  if (process.env.ICON) {
    await (await page.$('#pick-icon')).uploadFile(process.env.ICON)
    await page.waitForFunction(() => document.querySelector('#icon-prev img'), { timeout: 20000 })
    const dims = await page.$eval('#icon-prev img', (i) => new Promise((r) => i.complete ? r([i.naturalWidth, i.naturalHeight]) : i.onload = () => r([i.naturalWidth, i.naturalHeight])))
    check(dims[0] === 432 && dims[1] === 432, `the icon layer is 432 x 432 (${dims.join(' x ')})`)
  }
  await page.screenshot({ path: join(outdir, 'page-ready.png'), fullPage: true })
  await page.click('#build')
  await page.waitForFunction(() => !document.getElementById('download').classList.contains('hidden') ||
    document.getElementById('log').textContent.includes('FAILED'), { timeout: 120000 })
  const logText = await page.$eval('#log', (e) => e.textContent)
  check(!logText.includes('FAILED'), `built: ${logText.trim().split('\n').at(-1)}`)
  await page.screenshot({ path: join(outdir, 'page-built.png'), fullPage: true })

  // The download, fetched from its blob URL inside the page.
  const b64 = await page.$eval('#download', async (a) => {
    const buf = new Uint8Array(await (await fetch(a.href)).arrayBuffer())
    let s = ''
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return btoa(s)
  })
  writeFileSync(join(outdir, 'page.apk'), Buffer.from(b64, 'base64'))

  // The desktop targets, from the same page, module and icon.
  for (const t of ['linux', 'windows', 'macos']) {
    const has = await page.$eval(`.target[data-id=${t}] small`, (e) => e.textContent)
    if (/no kit/.test(has)) { console.log(`  skip ${t} (no kit beside the page)`); continue }
    await page.click(`.target[data-id=${t}]`)
    check(await page.$eval('#s-key', (e) => getComputedStyle(e).display === 'none'), `${t}: the Android-only signing key is hidden`)
    const idShown = await page.$eval('#pkg', (e) => e.closest('label').offsetParent !== null)
    check(idShown === (t === 'macos'), `${t}: the id field is ${t === 'macos' ? 'shown (bundle id)' : 'hidden'}`)
    check(!(await page.$eval('#build', (b) => b.disabled)), `${t}: Build is enabled with no key`)
    await page.$eval('#log', (e) => { e.textContent = '' })
    await page.click('#build')
    await page.waitForFunction(() => /done in|FAILED/.test(document.getElementById('log').textContent), { timeout: 300000 })
    const l = await page.$eval('#log', (e) => e.textContent)
    check(!l.includes('FAILED'), `${t}: ${l.trim().split('\n').at(-1)}`)
    if (t === 'macos') {
      check(/signed ad hoc: com\.digidream\.pagetest/.test(l), 'macos: signed ad hoc under the bundle id from the page')
      check(/icon: electron\.icns replaced/.test(l), 'macos: the icon became the .icns')
    }
    if (t === 'windows') check(/icon: written into .*\.exe at 16, 32, 48, 256 px/.test(l), 'windows: the icon went into the .exe')
    const size = await page.$eval('#download', async (a) => (await (await fetch(a.href)).blob()).size)
    check(size > 50 * 1048576, `${t}: the download is ${(size / 1048576).toFixed(0)} MB`)
  }
  // The Tauri option, on whichever desktop target has a Tauri kit here.
  const tauriTarget = await page.evaluate(async () => {
    for (const id of ['macos', 'linux', 'windows']) {
      const r = await fetch(`build/kits/tauri-${id === 'macos' ? 'macos-arm64' : id}.zip`, { method: 'HEAD' })
      if (r.ok) return id
    }
    return null
  })
  if (tauriTarget) {
    await page.click(`.target[data-id=${tauriTarget}]`)
    await page.select('#shell', 'tauri')
    await page.waitForFunction((id) => document.querySelector(`.target[data-id=${id}] small`).textContent.includes('Tauri'), {}, tauriTarget)
    check(await page.$eval('#studio', (e) => e.disabled && e.value === '0'), 'tauri: the studio is off (game only)')
    await page.$eval('#log', (e) => { e.textContent = '' })
    await page.click('#build')
    await page.waitForFunction(() => /done in|FAILED/.test(document.getElementById('log').textContent), { timeout: 300000 })
    const l = await page.$eval('#log', (e) => e.textContent)
    check(!l.includes('FAILED') && /Tauri runner/.test(l), `tauri ${tauriTarget}: ${l.trim().split('\n').at(-1)}`)
    const size = await page.$eval('#download', async (a) => (await (await fetch(a.href)).blob()).size)
    check(size < 40 * 1048576, `tauri ${tauriTarget}: the download is ${(size / 1048576).toFixed(1)} MB`)
    await page.select('#shell', 'electron')
  } else console.log('  skip tauri (no Tauri kit beside the page)')
  await page.screenshot({ path: join(outdir, 'page-desktop.png'), fullPage: true })
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(fails ? `== ${fails} failure(s) ==` : '== page smoke ok ==')
process.exit(fails ? 1 : 0)
