// The packager's DESKTOP APP, driven: launched, its own window connected to
// over the DevTools protocol, and used as a user would.
//
//   cd <dir with puppeteer-core@23>
//   node /abs/path/packager/test/app.desktop.mjs <app executable> <module.zip> <outdir> [kit.zip]
//
// e.g. on a Mac, after ditto -x -k "Digidream Packager-macos-arm64.zip" <dir>:
//   ... "<dir>/Digidream Packager.app/Contents/MacOS/Electron" starter.zip /tmp/out packager/build/kits/linux.zip
//
// Opens the module, makes a key, builds an Android game from the kit the app
// ships with and SAVES it (PACKAGER_SAVE_DIR stands in for the save dialog);
// with a kit.zip, also loads it into the app's kit store and builds that
// platform. A window opens while it runs.

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const puppeteer = createRequire(join(process.cwd(), 'x.js'))('puppeteer-core')
const [exe, moduleZip, outdir, extraKit] = process.argv.slice(2)
if (!exe || !moduleZip || !outdir) { console.error('usage: app.desktop.mjs <app executable> <module.zip> <outdir> [kit.zip]'); process.exit(2) }

let fails = 0
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const env = { ...process.env, PACKAGER_SAVE_DIR: outdir }
delete env.ELECTRON_RUN_AS_NODE // VS Code exports it; with it the app is plain Node
const PORT = 9333
// PACKAGER_APP_ARGS: extra switches, e.g. a software renderer in a container.
const extra = (process.env.PACKAGER_APP_ARGS ?? '').split(' ').filter(Boolean)
const app = spawn(exe, [`--remote-debugging-port=${PORT}`, ...extra], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
app.stdout.on('data', (b) => { log += b }); app.stderr.on('data', (b) => { log += b })

let browser
try {
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(500)
    try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null }) } catch {}
  }
  check(!!browser, 'the app started and its window can be reached')
  let page
  for (let i = 0; i < 20 && !page; i++) { page = (await browser.pages()).find((p) => p.url().startsWith('app://packager/')); if (!page) await sleep(500) }
  check(!!page, `the window shows the packager (${page?.url()})`)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('#targets .target')
  check(await page.evaluate(() => window.packagerHost?.kind === 'desktop'), 'the page sees the desktop host')
  // The kit check is asynchronous; a slow machine shows "no kit" for a moment.
  const bundled = await page.waitForFunction(() => document.querySelector('.target[data-id=android] small').textContent.includes('APK'), { timeout: 30000 }).then(() => true, () => false)
  check(bundled, 'Android is available out of the box (the bundled kit)')

  await (await page.$('#pick-zip')).uploadFile(moduleZip)
  await page.waitForFunction(() => /level\(s\)/.test(document.getElementById('mod-summary').textContent), { timeout: 30000 })
  if ((await page.$eval('#key-status', (e) => e.textContent)).includes('No key')) {
    await page.click('#key-new')
    await page.waitForFunction(() => document.getElementById('key-status').textContent.includes('Key ready'), { timeout: 60000 })
  }
  await page.click('.target[data-id=android]')
  await page.click('#build')
  await page.waitForFunction(() => /done in|FAILED/.test(document.getElementById('log').textContent), { timeout: 120000 })
  let l = await page.$eval('#log', (e) => e.textContent)
  check(!l.includes('FAILED'), `android: ${l.trim().split('\n').at(-1)}`)
  check(await page.$eval('#download', (e) => e.textContent.startsWith('Save ')), 'the button says Save, not Download')
  await page.click('#download')
  await page.waitForFunction(() => /saved: |not saved/.test(document.getElementById('log').textContent), { timeout: 60000 })
  l = await page.$eval('#log', (e) => e.textContent)
  const saved = /saved: (.+)$/m.exec(l)?.[1]
  check(saved && existsSync(saved) && statSync(saved).size > 1e6, `the APK was saved: ${saved}`)

  if (extraKit) {
    await (await page.$('#pick-kit')).uploadFile(extraKit)
    await page.waitForFunction(() => /Kept in this app/.test(document.getElementById('kit-list').textContent), { timeout: 120000 })
    const target = await page.evaluate(() => document.querySelector('.target[aria-pressed=true]').dataset.id)
    check(true, `the kit went into the app's kit store and selected ${target}`)
    await page.$eval('#log', (e) => { e.textContent = '' })
    await page.click('#build')
    await page.waitForFunction(() => /done in|FAILED/.test(document.getElementById('log').textContent), { timeout: 300000 })
    l = await page.$eval('#log', (e) => e.textContent)
    check(!l.includes('FAILED'), `${target}: ${l.trim().split('\n').at(-1)}`)
    await page.click('#download')
    await page.waitForFunction(() => /saved: |not saved/.test(document.getElementById('log').textContent), { timeout: 120000 })
    const s2 = /saved: (.+)$/m.exec(await page.$eval('#log', (e) => e.textContent))?.[1]
    check(s2 && existsSync(s2) && statSync(s2).size > 5e7, `${target} saved: ${s2}`)
  }
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} catch (e) {
  check(false, e.message)
} finally {
  try { await browser?.disconnect() } catch {}
  app.kill('SIGTERM')
}
if (fails) console.log(log.split('\n').slice(-15).join('\n'))
console.log(fails ? `== ${fails} failure(s) ==` : '== desktop app ok ==')
process.exit(fails ? 1 : 0)
