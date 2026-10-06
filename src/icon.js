// A picture into an Android launcher icon, in the page.
//
// The kit's icon is an ADAPTIVE icon: a 108 dp layer of which every launcher
// shows at least the middle 72 dp, cut to its own shape (circle, squircle,
// rounded square). So the picture is fitted into that middle 72 dp, where no
// mask can cut it, and the rest of the layer is filled with the colour of the
// picture's own edge, so the mask's shape shows a continuation rather than a
// frame. 432 px square: 108 dp at xxxhdpi, the largest density a phone asks
// for, scaled down by the launcher for the rest.

export const ICON_PX = 432
const SAFE = 288 // 72 dp at xxxhdpi

/** file: a Blob (PNG, JPEG, WebP...). Returns PNG bytes. Needs a browser. */
export async function adaptiveIcon (file) {
  const img = await createImageBitmap(file)
  const c = new OffscreenCanvas(ICON_PX, ICON_PX)
  const g = c.getContext('2d')
  g.fillStyle = edgeColour(img)
  g.fillRect(0, 0, ICON_PX, ICON_PX)
  const k = Math.min(SAFE / img.width, SAFE / img.height)
  const w = Math.round(img.width * k)
  const h = Math.round(img.height * k)
  g.imageSmoothingQuality = 'high'
  g.drawImage(img, (ICON_PX - w) >> 1, (ICON_PX - h) >> 1, w, h)
  const blob = await c.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

// The average of the picture's outermost pixels; transparent ones count as
// the engine's dark background.
function edgeColour (img) {
  const n = 64
  const c = new OffscreenCanvas(n, n)
  const g = c.getContext('2d')
  g.drawImage(img, 0, 0, n, n)
  const d = g.getImageData(0, 0, n, n).data
  let r = 0, gg = 0, b = 0, k = 0
  for (let i = 0; i < n; i++) {
    for (const [x, y] of [[i, 0], [i, n - 1], [0, i], [n - 1, i]]) {
      const o = (y * n + x) * 4
      const a = d[o + 3] / 255
      r += d[o] * a + 11 * (1 - a); gg += d[o + 1] * a + 13 * (1 - a); b += d[o + 2] * a + 18 * (1 - a); k++
    }
  }
  const h = (v) => Math.round(v / k).toString(16).padStart(2, '0')
  return `#${h(r)}${h(gg)}${h(b)}`
}

/**
 * A plain square icon of `size` px for the desktop: the picture fitted whole,
 * centred, on transparency -- Windows and Linux draw icons unmasked, so
 * nothing needs to be kept away from the edges. Needs a browser.
 */
export async function squareIcon (file, size) {
  const img = await createImageBitmap(file)
  const c = new OffscreenCanvas(size, size)
  const g = c.getContext('2d')
  const k = Math.min(size / img.width, size / img.height)
  const w = Math.max(1, Math.round(img.width * k))
  const h = Math.max(1, Math.round(img.height * k))
  g.imageSmoothingQuality = 'high'
  g.drawImage(img, (size - w) >> 1, (size - h) >> 1, w, h)
  const blob = await c.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}
