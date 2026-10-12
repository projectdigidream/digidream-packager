// The Tauri runner's half of `window.dnpNative`, the native seam the engine's
// shared shell.js (engine/shells/android/web/shell.js) is written against --
// the same calls the Android shell provides (and quit, which iOS leaves out). The packager puts
// this in front of shell.js. The answers come back the same way too:
// window.__dnpDown(base64) and window.__dnpClosed(reason), from the runner.
//
// Page errors are forwarded to the runner's output ("[page] ..."): a web view
// has no console a player or a test can see, and a client that dies on load is
// otherwise a silent black window.
(function () {
  'use strict'
  const T = window.__TAURI__
  const invoke = (cmd, args) => (T ? T.core.invoke(cmd, args) : Promise.reject(new Error('no __TAURI__')))
  const log = (line) => { invoke('log', { line: String(line) }).catch(() => {}) }
  window.dnpNative = {
    up: (b64) => { invoke('up', { data: b64 }).catch((e) => log('up failed: ' + (e && e.message || e))) },
    close: () => { invoke('close').catch(() => {}) },
    // A main menu's "Quit" (SCREEN_SET `quit`): the runner exits.
    quit: () => { invoke('quit').catch((e) => log('quit failed: ' + (e && e.message || e))) },
    // The window and its web view focused, natively (pointer lock needs it on
    // macOS, and window.focus() cannot do it from inside a WKWebView).
    // Resolves with what the runner saw: "window focused -> focused".
    focus: () => invoke('focus').catch((e) => { log('focus failed: ' + (e && e.message || e)); return 'focus failed' }),
    log
  }
  window.addEventListener('error', (e) => log('error: ' + e.message + ' at ' + e.filename + ':' + e.lineno))
  window.addEventListener('unhandledrejection', (e) => log('rejection: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)))
  if (!T) console.error('tauri-native: window.__TAURI__ is missing (withGlobalTauri?)')
  log('shim up at ' + location.href)
})()
