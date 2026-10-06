// The Android app's host for the page (src/host.js), on top of the shell's
// JavascriptInterface (MainActivity.Bridge). Loaded as a CLASSIC script before
// the page's modules, so window.packagerHost exists when host.js reads it.
//
// Bytes cross into Java as base64 strings, 1 MiB at a time -- strings are what
// the interface carries -- into a staged file; then the shell saves it through
// the system's picker, or installs it. The shell answers through
// window.__packagerReply(token, ok, message).
(function () {
  const bridge = window.PackagerAndroid
  if (!bridge) return
  const waiting = {}
  window.__packagerReply = function (token, ok, msg) {
    const w = waiting[token]
    if (!w) return
    delete waiting[token]
    ok ? w.resolve(msg) : w.reject(new Error(msg))
  }
  function b64 (u8) {
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
    return btoa(s)
  }
  function stage (bytes) {
    const token = bridge.begin()
    for (let i = 0; i < bytes.length; i += 1 << 20) bridge.append(token, b64(bytes.subarray(i, i + (1 << 20))))
    return token
  }
  function answer (token) {
    return new Promise(function (resolve, reject) { waiting[token] = { resolve: resolve, reject: reject } })
  }
  window.packagerHost = {
    kind: 'android',
    kitsBase: 'kits/',
    save: function (bytes, name, type) {
      const token = stage(bytes)
      const p = answer(token)
      bridge.save(token, name, type || 'application/octet-stream')
      return p
    },
    install: function (bytes) {
      const token = stage(bytes)
      const p = answer(token)
      bridge.install(token)
      return p
    }
  }
})()
