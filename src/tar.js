// A .tar.gz, written in the page: how a Linux game is handed over, because a
// zip extracted by most Linux tools forgets which files were executable, and
// the game's launcher and its server must be.
//
// ustar, with a PAX header for a path too long for ustar's 100+155 split. The
// result is a Blob built from parts and gzipped as a stream, so a game of a few
// hundred megabytes is never one contiguous array in memory.

const enc = new TextEncoder()

function octal (n, width) {
  return enc.encode(n.toString(8).padStart(width - 1, '0') + '\0')
}

function header (name, size, mode, type = '0') {
  const h = new Uint8Array(512)
  const put = (bytes, at) => h.set(bytes.subarray(0, Math.min(bytes.length, 512 - at)), at)
  let nameBytes = enc.encode(name)
  let prefix = new Uint8Array(0)
  if (nameBytes.length > 100) {
    // Split at a slash so that prefix <= 155 and name <= 100.
    const cut = name.lastIndexOf('/', 155)
    if (cut > 0 && enc.encode(name.slice(cut + 1)).length <= 100 && enc.encode(name.slice(0, cut)).length <= 155) {
      prefix = enc.encode(name.slice(0, cut))
      nameBytes = enc.encode(name.slice(cut + 1))
    } else {
      return null // needs PAX
    }
  }
  put(nameBytes, 0)
  put(octal(mode & 0o7777, 8), 100)
  put(octal(0, 8), 108) // uid
  put(octal(0, 8), 116) // gid
  put(octal(size, 12), 124)
  put(octal(0, 12), 136) // mtime: fixed, so the same inputs give the same bytes
  h.fill(0x20, 148, 156) // checksum field counts as spaces
  h[156] = type.charCodeAt(0)
  put(enc.encode('ustar\0'), 257)
  put(enc.encode('00'), 263)
  put(prefix, 345)
  let sum = 0
  for (const b of h) sum += b
  put(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148)
  return h
}

const pad = (n) => new Uint8Array((512 - (n % 512)) % 512)

/** entries: [{ name, data: Uint8Array, mode }] -> Blob (application/gzip) */
export async function writeTarGz (entries) {
  const parts = []
  for (const e of entries) {
    let h = header(e.name, e.data.length, e.mode ?? 0o644)
    if (!h) {
      // PAX: a record "<len> path=<name>\n" in an 'x' entry before the file.
      // The length counts itself and is in BYTES (a path may be UTF-8).
      const body = enc.encode(` path=${e.name}\n`).length
      let len = body + 2
      while (String(len).length + body !== len) len = String(len).length + body
      const rec = enc.encode(`${len} path=${e.name}\n`)
      parts.push(header('PaxHeader', rec.length, 0o644, 'x'), rec, pad(rec.length))
      h = header(e.name.slice(-100).replace(/^[^/]*\//, ''), e.data.length, e.mode ?? 0o644)
    }
    parts.push(h, e.data, pad(e.data.length))
  }
  parts.push(new Uint8Array(1024))
  const gz = new Blob(parts).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(gz).blob()
}
