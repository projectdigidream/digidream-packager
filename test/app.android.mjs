// The packager's ANDROID APP, driven on a device or emulator: a game built ON
// THE PHONE, saved, and installed by the packager itself.
//
//   packager/scripts/build_app_android.sh --debuggable
//   cd <dir with puppeteer-core@23>
//   node /abs/path/packager/test/app.android.mjs <module.zip>
//
// Installs build/apps/digidream-packager.apk, starts it, connects to its
// WebView over adb (DevTools), opens the module from the app's own storage,
// makes a key, builds an APK, saves it (files/autosave stands in for the
// picker in a debuggable build), then presses "Install on this phone", accepts
// the system's confirmation with a tap, and checks the game is installed and
// starts. Uses adb against the emulator -- the APK itself needs none.

import { spawnSync } from 'node:child_process'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

const puppeteer = createRequire(join(process.cwd(), 'x.js'))('puppeteer-core')
const HERE = dirname(fileURLToPath(import.meta.url))
const APK = join(HERE, '..', 'build', 'apps', 'digidream-packager.apk')
const [moduleZip] = process.argv.slice(2)
if (!moduleZip) { console.error('usage: app.android.mjs <module.zip>'); process.exit(2) }
const ADB = join(process.env.ANDROID_HOME ?? join(homedir(), 'Library', 'Android', 'sdk'), 'platform-tools', 'adb')
const PKG = 'com.digidream.packager'
// A fresh id every run: Play Protect remembers an app it was told to allow, so
// a reused id would skip the very warning this has to get past.
const GAME = `com.digidream.phonetest${Date.now().toString(36)}`

let fails = 0
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const adb = (...a) => spawnSync(ADB, a, { encoding: 'utf8' })
const sh = (cmd) => adb('shell', cmd).stdout

check(adb('install', '-r', APK).stdout.includes('Success'), 'the packager installs')
adb('uninstall', GAME)
// The module, in the app's own storage, where its WebView may read it.
adb('push', moduleZip, '/data/local/tmp/module.zip')
sh(`run-as ${PKG} sh -c 'mkdir -p files && cp /data/local/tmp/module.zip files/module.zip && touch files/autosave && rm -rf files/out'`)
sh(`am force-stop ${PKG}`)
sh(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`)
await sleep(4000)
const pid = sh(`pidof ${PKG}`).trim()
check(!!pid, `it runs (pid ${pid})`)
adb('forward', 'tcp:9444', `localabstract:webview_devtools_remote_${pid}`)

let browser
try {
  for (let i = 0; i < 20 && !browser; i++) {
    try { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9444', defaultViewport: null }) } catch { await sleep(500) }
  }
  check(!!browser, 'its WebView can be reached over adb')
  const page = (await browser.pages()).find((p) => p.url().startsWith('https://appassets.androidplatform.net/'))
  check(!!page, `the packager page is loaded (${page?.url()})`)
  check(await page.evaluate(() => window.packagerHost?.kind === 'android' && window.isSecureContext && !!crypto.subtle), 'Android host, secure context, WebCrypto')
  const bundled = await page.waitForFunction(() => document.querySelector('.target[data-id=android] small').textContent.includes('APK'), { timeout: 30000 }).then(() => true, () => false)
  check(bundled, 'Android is available out of the box (the bundled kit)')

  // The file input, given a path on the DEVICE (the app's own files/).
  const cdp = await page.target().createCDPSession()
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#pick-zip' })
  await cdp.send('DOM.setFileInputFiles', { files: [`/data/data/${PKG}/files/module.zip`], nodeId })
  await page.waitForFunction(() => /level\(s\)/.test(document.getElementById('mod-summary').textContent), { timeout: 60000 })
  check(true, `module read: ${(await page.$eval('#mod-summary', (e) => e.textContent)).split('—')[0].trim()}`)

  if ((await page.$eval('#key-status', (e) => e.textContent)).includes('No key')) {
    await page.click('#key-new')
    await page.waitForFunction(() => document.getElementById('key-status').textContent.includes('Key ready'), { timeout: 120000 })
  }
  await page.$eval('#pkg', (e, id) => { e.value = id; e.dispatchEvent(new Event('input')) }, GAME)
  await page.$eval('#label', (e) => { e.value = 'Phone Test'; e.dispatchEvent(new Event('input')) })
  await page.click('#build')
  await page.waitForFunction(() => /done in|FAILED/.test(document.getElementById('log').textContent), { timeout: 300000 })
  let l = await page.$eval('#log', (e) => e.textContent)
  check(!l.includes('FAILED'), `built on the phone: ${l.trim().split('\n').at(-1)}`)

  await page.click('#download')
  await page.waitForFunction(() => /saved: |not saved/.test(document.getElementById('log').textContent), { timeout: 120000 })
  l = await page.$eval('#log', (e) => e.textContent)
  const saved = /saved: (.+)$/m.exec(l)?.[1]
  check(!!saved && sh(`run-as ${PKG} ls -l files/out`).includes('.apk'), `saved: ${saved}`)

  check(await page.$eval('#install', (e) => !e.classList.contains('hidden')), 'the Install button is offered')
  // A fresh install of the packager may not install apps until the user allows
  // it ("Install unknown apps"); that switch is flipped here, as a user would.
  sh(`appops set ${PKG} REQUEST_INSTALL_PACKAGES allow`)
  await page.click('#install')
  // The system's confirmation, then -- on a phone with Google Play Protect --
  // its warning about an app from an unknown developer. A user taps Install,
  // then "More details" and "Install anyway"; so does this. (The first version
  // tapped only Install: the session then sat at 90% behind Play Protect until
  // a person clicked "Install anyway" on the emulator.)
  const BUTTONS = ['Install anyway', 'INSTALL ANYWAY', 'Install', 'INSTALL', 'Update', 'UPDATE', 'More details', 'MORE DETAILS']
  const tappedTexts = []
  for (let i = 0; i < 30 && !sh(`pm list packages ${GAME}`).includes(GAME); i++) {
    await sleep(1500)
    sh('uiautomator dump /sdcard/ui.xml >/dev/null 2>&1')
    const xml = sh('cat /sdcard/ui.xml')
    const nodes = [...xml.matchAll(/<node [^>]*>/g)].map((m) => m[0])
    const hit = BUTTONS.map((t) => nodes.find((n) => n.includes(`text="${t}"`) && n.includes('clickable="true"'))).find(Boolean)
    if (!hit) continue
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(hit)
    sh(`input tap ${(+b[1] + +b[3]) >> 1} ${(+b[2] + +b[4]) >> 1}`)
    tappedTexts.push(/text="([^"]+)"/.exec(hit)[1])
  }
  const tapped = tappedTexts.length > 0
  if (tapped) console.log(`       tapped: ${tappedTexts.join(' -> ')}`)
  if (!tapped) console.log('       the packager says: ' + (await page.$eval('#log', (e) => e.textContent)).trim().split('\n').slice(-2).join(' | '))
  check(tapped, 'the system asked, and Install was tapped')
  let installed = false
  // Up to two minutes: Play Protect verifies a new APK after the user says yes.
  for (let i = 0; i < 80 && !installed; i++) { await sleep(1500); installed = sh(`pm list packages ${GAME}`).includes(GAME) }
  check(installed, `${GAME} is installed`)
  if (installed) {
    sh(`monkey -p ${GAME} -c android.intent.category.LAUNCHER 1`)
    await sleep(8000)
    check(sh(`pidof ${GAME}`).trim() !== '', 'the game the phone built starts')
    check(sh(`pm list packages -i ${GAME}`).includes('installer=com.digidream.packager'), 'installed BY the packager')
    adb('exec-out', 'screencap', '-p')
    spawnSync('sh', ['-c', `"${ADB}" exec-out screencap -p > "${join(HERE, '..', 'build', 'test', 'phone-built-game.png')}"`])
  }
} catch (e) {
  check(false, e.message)
} finally {
  try { await browser?.disconnect() } catch {}
  adb('uninstall', GAME)
}
console.log(fails ? `== ${fails} failure(s) ==` : '== android app ok ==')
process.exit(fails ? 1 : 0)
