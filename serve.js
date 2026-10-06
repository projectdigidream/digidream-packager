// A static server for the packager, for running it from a checkout.
//
//   node packager/serve.js            # http://127.0.0.1:8950/
//
// The packager is a page and nothing else: every byte of work happens in the
// browser. This only hands out packager/ (the page, src/, build/kits/), so any
// static host does the same job -- including a phone's own app shell. WebCrypto
// needs a secure context, which 127.0.0.1 is; a LAN address over plain http is
// NOT, so to open it from a phone on the network serve it over https.

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.DNP_PACKAGER_PORT ?? 8950)
const HOST = process.env.DNP_PACKAGER_HOST ?? '127.0.0.1'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  let path = decodeURIComponent(url.pathname)
  if (path.endsWith('/')) path += 'index.html'
  const file = normalize(join(ROOT, path))
  if (!file.startsWith(ROOT + '/') || /\/(test|scripts)\//.test(file.slice(ROOT.length))) {
    res.writeHead(404).end(); return
  }
  try {
    const st = await stat(file)
    if (!st.isFile()) throw new Error('not a file')
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-store'
    })
    if (req.method === 'HEAD') { res.end(); return }
    res.end(await readFile(file))
    console.log(`[packager] 200 ${path}`)
  } catch {
    res.writeHead(404).end()
    console.log(`[packager] 404 ${path}`)
  }
}).listen(PORT, HOST, () => console.log(`[packager] http://${HOST}:${PORT}/`))
