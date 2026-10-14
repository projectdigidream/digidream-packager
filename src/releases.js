// Where kits come from: the engine's GitHub releases.
//
// A kit is the engine prebuilt for one platform (packager/scripts/build_kits.sh),
// and every engine release carries the full set, named
// digidream-engine-<version>-kit-<store name>.zip -- the store names of
// kitstore.js. The release list is GitHub's API, which a page may read from
// anywhere. The files themselves are another matter: GitHub serves them
// without the header a page needs to read a download, so a browser tab can only
// hand the link to the browser; the desktop app downloads them itself
// (host.download).

export const ENGINE_REPO = 'projectdigidream/digidream-engine'
export const RELEASES_PAGE = `https://github.com/${ENGINE_REPO}/releases`

/** The kits of an engine release: { tag, kits: { storeName: { url, size, file } } }. */
export async function releaseKits (tag = 'latest', fetchFn = fetch) {
  const path = tag === 'latest' ? 'latest' : `tags/${encodeURIComponent(tag)}`
  const r = await fetchFn(`https://api.github.com/repos/${ENGINE_REPO}/releases/${path}`, { headers: { accept: 'application/vnd.github+json' } })
  if (!r.ok) throw new Error(`the engine's releases could not be read (${r.status})`)
  return kitsOf(await r.json())
}

/** The kit assets of one release's JSON (pure, for the tests). */
export function kitsOf (release) {
  const kits = {}
  for (const a of release.assets ?? []) {
    const m = /-kit-([a-z0-9-]+)\.zip$/.exec(a.name)
    if (m) kits[m[1]] = { url: a.browser_download_url, size: a.size, file: a.name }
  }
  return { tag: release.tag_name, kits }
}

export const megabytes = (n) => `${Math.max(1, Math.round(n / 1048576))} MB`
