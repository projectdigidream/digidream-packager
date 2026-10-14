// What the packager needs from whatever is running it, and nothing more.
//
// The page is the same everywhere -- a browser tab, the desktop app
// (shells/desktop, Electron), the Android app (shells/android, a WebView). They
// differ in exactly two things:
//
//   save(blob, name)   a browser downloads; the desktop app asks where with the
//                      system dialog; the Android app hands it to the system's
//                      file picker, and can then INSTALL an APK it just built.
//   kitsBase           where kits that ship WITH the tool live, if any.
//   module()           a host that already HAS a module (the Digidream suite,
//                      where the packager is a page) hands it in as a pack
//                      zip, so there is nothing to pick.
//
// A shell announces itself by defining window.packagerHost before this module
// loads (the desktop preload, the Android shell's injected script). Without
// one, the page is a page.

const shell = typeof window !== 'undefined' ? window.packagerHost : undefined

export const host = {
  kind: shell?.kind ?? 'browser',

  // Kits bundled with the tool. The checkout serves packager/build/kits/.
  kitsBase: shell?.kitsBase ?? 'build/kits/',

  canInstall: !!shell?.install,

  /**
   * Download a URL's bytes the way the host can: the desktop app fetches it
   * itself (no page rules apply there); null where the host cannot, and the
   * page then hands the link to the browser (releases.js says why).
   */
  download: shell?.download ? (url) => shell.download(url) : null,

  /** The module the host has open, as a pack zip (Uint8Array), or null. */
  initialModule: shell?.module ?? null,

  /** Hand a finished file to the user. Resolves to a description of where it went. */
  async save (blob, name) {
    // Shells get BYTES: a Blob does not cross every bridge (Electron's
    // contextBridge, Android's JavascriptInterface), a Uint8Array does.
    if (shell?.save) return shell.save(new Uint8Array(await blob.arrayBuffer()), name, blob.type)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 60000)
    return 'downloaded'
  },

  /** Android only: install an APK just built. */
  async install (blob, name) {
    if (!shell?.install) throw new Error('installing is only possible in the Android app')
    return shell.install(new Uint8Array(await blob.arrayBuffer()), name)
  }
}
