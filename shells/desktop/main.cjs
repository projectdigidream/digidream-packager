// The packager's desktop app: Electron showing the packager page, and nothing
// else. Assembled for Windows, Linux and macOS by packager/scripts/
// build_apps.mjs -- with the packager's own builders, from the desktop kits'
// Electron runtimes.
//
// The page is served from app://packager/, a privileged scheme: a SECURE
// context (WebCrypto, OPFS and module workers need one) with no network port
// opened. Files come from www/ beside this file: the page, src/, and the kits
// that ship with the tool (kits/android.zip).

const { app, BrowserWindow, protocol, ipcMain, dialog, shell } = require('electron')
const { readFile, writeFile } = require('node:fs/promises')
const { join, normalize, extname } = require('node:path')

const WWW = join(__dirname, 'www')
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}])

app.whenReady().then(() => {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url)
    let path = decodeURIComponent(url.pathname)
    if (path.endsWith('/')) path += 'index.html'
    const file = normalize(join(WWW, path))
    if (!file.startsWith(WWW)) return new Response('', { status: 404 })
    try {
      const body = await readFile(file)
      return new Response(req.method === 'HEAD' ? null : body, {
        headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': String(body.length) }
      })
    } catch {
      return new Response('', { status: 404 })
    }
  })

  // Where a finished game goes: the system's save dialog, starting in
  // Downloads. PACKAGER_SAVE_DIR skips the dialog (the tests drive the app).
  ipcMain.handle('save', async (_e, name, bytes) => {
    let file
    if (process.env.PACKAGER_SAVE_DIR) file = join(process.env.PACKAGER_SAVE_DIR, name)
    else {
      const r = await dialog.showSaveDialog(win, { defaultPath: join(app.getPath('downloads'), name) })
      if (r.canceled || !r.filePath) throw new Error('cancelled')
      file = r.filePath
    }
    await writeFile(file, Buffer.from(bytes))
    if (!process.env.PACKAGER_SAVE_DIR) shell.showItemInFolder(file)
    return file
  })

  // A kit from the engine's GitHub releases. Only from there: the page names
  // the URL, and this is no general-purpose fetch for it.
  ipcMain.handle('download', async (_e, url) => {
    if (!/^https:\/\/github\.com\/projectdigidream\/digidream-engine\/releases\/download\//.test(url)) throw new Error('not a kit of the engine releases')
    const r = await fetch(url)
    if (!r.ok) throw new Error(`download failed (${r.status})`)
    return new Uint8Array(await r.arrayBuffer())
  })

  const win = new BrowserWindow({
    width: 860,
    height: 1000,
    title: 'Digidream Packager',
    backgroundColor: '#15171b',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true }
  })
  win.loadURL('app://packager/index.html')
})

app.on('window-all-closed', () => app.quit())
