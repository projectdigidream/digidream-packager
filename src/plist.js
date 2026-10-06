// Apple XML property lists: read Electron's Info.plist, edit it, and write
// plists the way Apple's own writer formats them (tabs, <data> on its own
// lines) -- CodeResources included, which `codesign --verify` then reads.
//
// Values: string -> string, integer -> { int: n }, real -> { real: n },
// true/false -> boolean, data -> Uint8Array, date -> { date: string },
// array -> Array, dict -> Map (insertion-ordered; written in that order).

const dec = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s) }
const unb64 = (s) => Uint8Array.from(atob(s.replace(/\s+/g, '')), (c) => c.charCodeAt(0))

export function parsePlist (text) {
  // Tags (attributes allowed, `/>` = empty) and the text between them.
  const re = /<(\/?)([a-zA-Z]+)([^>]*)>|([^<]+)/g
  const tokens = []
  let m
  const body = text.slice(text.indexOf('<plist'))
  while ((m = re.exec(body))) {
    if (m[4] !== undefined) tokens.push({ text: m[4] })
    else tokens.push({ close: !!m[1], tag: m[2], empty: m[3].trim().endsWith('/') })
  }
  let i = 0
  const textOf = (tag) => {
    let s = ''
    while (!(tokens[i].close && tokens[i].tag === tag)) { s += tokens[i].text ?? ''; i++ }
    i++
    return s
  }
  const skip = () => { while (tokens[i] && tokens[i].text !== undefined) i++ }
  const value = () => {
    skip()
    const t = tokens[i++]
    if (t.empty) {
      if (t.tag === 'true') return true
      if (t.tag === 'false') return false
      if (t.tag === 'string') return ''
      if (t.tag === 'dict') return new Map()
      if (t.tag === 'array') return []
      if (t.tag === 'data') return new Uint8Array(0)
    }
    switch (t.tag) {
      case 'string': return dec(textOf('string'))
      case 'integer': return { int: Number(textOf('integer').trim()) }
      case 'real': return { real: Number(textOf('real').trim()) }
      case 'date': return { date: textOf('date').trim() }
      case 'data': return unb64(textOf('data'))
      case 'true': if (tokens[i]?.close) i++; return true
      case 'false': if (tokens[i]?.close) i++; return false
      case 'array': {
        const a = []
        for (skip(); !(tokens[i].close && tokens[i].tag === 'array'); skip()) a.push(value())
        i++
        return a
      }
      case 'dict': {
        const d = new Map()
        for (skip(); !(tokens[i].close && tokens[i].tag === 'dict'); skip()) {
          if (tokens[i].tag !== 'key') throw new Error(`plist: expected <key>, got <${tokens[i].tag}>`)
          i++
          const k = dec(textOf('key'))
          d.set(k, value())
        }
        i++
        return d
      }
    }
    throw new Error(`plist: unexpected <${t.tag}>`)
  }
  while (tokens[i] && tokens[i].tag !== 'plist') i++
  i++
  return value()
}

export function writePlist (root) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">']
  const w = (v, d) => {
    const t = '\t'.repeat(d)
    if (typeof v === 'string') out.push(`${t}<string>${escape(v)}</string>`)
    else if (v === true) out.push(`${t}<true/>`)
    else if (v === false) out.push(`${t}<false/>`)
    else if (v instanceof Uint8Array) out.push(`${t}<data>`, `${t}${b64(v)}`, `${t}</data>`)
    else if (Array.isArray(v)) {
      if (!v.length) { out.push(`${t}<array/>`); return }
      out.push(`${t}<array>`); for (const x of v) w(x, d + 1); out.push(`${t}</array>`)
    } else if (v instanceof Map) {
      if (!v.size) { out.push(`${t}<dict/>`); return }
      out.push(`${t}<dict>`)
      for (const [k, x] of v) { out.push(`${t}\t<key>${escape(k)}</key>`); w(x, d + 1) }
      out.push(`${t}</dict>`)
    } else if ('int' in v) out.push(`${t}<integer>${v.int}</integer>`)
    else if ('real' in v) out.push(`${t}<real>${v.real}</real>`)
    else if ('date' in v) out.push(`${t}<date>${v.date}</date>`)
    else throw new Error('plist: cannot write ' + JSON.stringify(v))
  }
  w(root, 0)
  out.push('</plist>', '')
  return new TextEncoder().encode(out.join('\n'))
}
