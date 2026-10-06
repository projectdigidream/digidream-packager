// A kit's server, alive: started on a real module, joined, and answering.
//
//   node packager/test/server.smoke.mjs <module dir> <server command...>
//   node packager/test/server.smoke.mjs modules/starter wine dnp-server.exe
//
// For the servers this machine cannot run natively -- the Linux one in a Linux
// container, the Windows one under Wine in the same container (see
// packager/scripts/build_kits.sh). Compiling for a platform proves nothing about
// running on it; this does the least a game needs: the server loads the
// module's maps and scripts, accepts the link, opens a session, puts a player
// in a level, and streams snapshots whose ticks advance while input arrives.
//
// The link client is the engine's own (server/edge/src/upstream.js), as
// tools/mobperf uses it: no edge, no browser, the frames the shells send.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const { Upstream } = await import(join(REPO, 'engine/server/edge/src/upstream.js'))
const { encodeHello, encodeInputBundle, axisFromNumber, decodeSnapshot } = await import(join(REPO, 'engine/client/src/proto.js'))

const [moduleDir, ...cmdIn] = process.argv.slice(2)
// The server runs with engine/ as its cwd, so paths given relative to HERE are
// made absolute first (the binary, and the .exe Wine is handed).
const cmd = (cmdIn ?? []).map((c) => (c.includes('/') && existsSync(c) ? resolve(c) : c))
if (!moduleDir || cmdIn.length === 0) { console.error('usage: server.smoke.mjs <module dir> <server command...>'); process.exit(2) }
const PORT = Number(process.env.SMOKE_PORT ?? 34811)
const SECS = Number(process.env.SMOKE_SECS ?? 6)

let fails = 0
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The engine's catalogues: the server reads assets/props.txt against its cwd,
// exactly as the desktop shell arranges (cwd = the game directory).
const args = [...cmd.slice(1), '--port', String(PORT), '--module', resolve(moduleDir)]
console.log(`server: ${cmd[0]} ${args.join(' ')}`)
const srv = spawn(cmd[0], args, { cwd: join(REPO, 'engine'), stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
srv.stdout.on('data', (d) => { log += d })
srv.stderr.on('data', (d) => { log += d })
const exited = new Promise((r) => srv.on('exit', (c) => r(c)))

try {
  const deadline = Date.now() + 60000 // Wine's first start builds a prefix
  while (!/listening for edge/.test(log)) {
    if (Date.now() > deadline) throw new Error('the server never listened')
    if (srv.exitCode !== null) throw new Error(`the server exited ${srv.exitCode}`)
    await sleep(100)
  }
  check(true, 'the server loaded the module and listens')

  const up = new Upstream({ host: '127.0.0.1', port: PORT, reconnectMs: 200 })
  const snaps = []
  up.on('frame', (f) => {
    if (f.type !== 0x04) return
    try { const s = decodeSnapshot(f.payload); if (s) snaps.push(s) } catch {}
  })
  const opened = new Promise((r) => up.once('connected', r))
  up.connect()
  await opened
  up.sessionOpen(1, { path: '/dnp' })
  up.send(0x03, 1, encodeHello())
  let clientTick = 0
  const timer = setInterval(() => {
    clientTick++
    const t = clientTick / 60
    try {
      up.send(0x04, 1, encodeInputBundle({ clientTick, ackSnapshotTick: 0,
        frames: [{ buttons: 0, moveX: axisFromNumber(Math.cos(t)), moveY: axisFromNumber(Math.sin(t)), aim: 0 }] }))
    } catch {}
  }, 1000 / 60)
  await sleep(SECS * 1000)
  clearInterval(timer)
  up.stop()

  check(/session 1 -> level \d+ agent \d+/.test(log), 'a session opened and got a player in a level')
  check(snaps.length >= SECS * 10, `snapshots streamed: ${snaps.length} in ${SECS} s`)
  const ticks = snaps.map((s) => s.tick ?? s.serverTick).filter((t) => typeof t === 'number')
  check(ticks.length > 1 && ticks.at(-1) > ticks[0], `the world ticks: ${ticks[0]} .. ${ticks.at(-1)}`)
  // Lines from Wine itself (its first start sets up a prefix noisily) are not
  // the server's.
  const errors = log.split('\n').filter((l) => !l.startsWith('wine:') && /\[lua\].*error|refusing|failed/i.test(l))
  check(errors.length === 0, `no script or load errors${errors.length ? ':\n      ' + errors.slice(0, 5).join('\n      ') : ''}`)
} catch (e) {
  check(false, e.message)
} finally {
  srv.kill('SIGKILL')
  await exited
  if (fails) console.log(log.split('\n').slice(-25).join('\n'))
}
console.log(fails ? `== ${fails} failure(s) ==` : '== server smoke ok ==')
process.exit(fails ? 1 : 0)
