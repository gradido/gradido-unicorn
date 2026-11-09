/*
 * The renderer in JavaScript: what ge_run does in src/render.c, op for op.
 *
 * Every JS consumer of the IR renders through this file -- the snapshots, the
 * preview page (tools/preview.mjs pastes this source into it verbatim) and the
 * tests. The C is measured against what it produces, never against itself.
 *
 * Self-contained on purpose: no imports, so the page can carry it unchanged.
 *
 * An op is an array:
 *
 *   ['lit', s]                 the bytes s
 *   ['slot', i, mode]          value i, in one of the modes below
 *   ['jz', [i, ...], target]   jump to op index `target` unless every value i is set
 *   ['jmp', target]
 *   ['brk', n]                 text only: n line breaks before the next output,
 *                              merged by max, dropped at the start and the end
 *
 * Value 0 is the locale. A value is "set" when it is a non-empty string or true --
 * GE_HAS() in C.
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c])

/* encodeURIComponent, byte for byte as ge_put_uri writes it. */
const uri = (s) => encodeURIComponent(String(s))

/*
 * Text a person typed, with its addresses as links: legacy's
 * core/src/logic/HumanText.logic.ts, whose patterns are the wallet's. The C in
 * src/render.c (ge_human) reproduces exactly these regular expressions.
 */
const URL_PATTERN = /\b(?:https?|ftp):\/\/[-A-Z0-9+&@#/%?=~_|!:,.;]*[-A-Z0-9+&@#/%=~_|]/gi
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const BOLD_PATTERN = /\*\*([\s\S]+?)\*\*/g
const OWN_VIDEO_ADDITION =
  /^([^#]*)#config\.subject=([^&#]*)(?:&gradido\.start=(\d{1,12})&gradido\.end=(\d{1,12}))?$/

function cut(text, pattern, found, between) {
  const parts = []
  let last = 0
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) parts.push(...between(text.slice(last, m.index)))
    parts.push(found(m))
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(...between(text.slice(last)))
  return parts
}

function humanParts(text, bold) {
  const plain = (s) => [{ type: 'text', value: s }]
  const boldOrPlain = (s) => cut(s, BOLD_PATTERN, (m) => ({ type: 'bold', value: m[1] }), plain)
  const web = (m) => {
    const room = OWN_VIDEO_ADDITION.exec(m[0])?.[1]
    return room ? { type: 'url', value: m[0], shown: room } : { type: 'url', value: m[0] }
  }
  return cut(String(text), URL_PATTERN, web, (s) =>
    cut(s, EMAIL_PATTERN, (m) => ({ type: 'email', value: m[0] }), bold ? boldOrPlain : plain),
  )
}

/* As legacy's includes/humanText.pug writes the parts -- and html-to-text reads them. */
function human(text, bold, html) {
  let out = ''
  for (const p of humanParts(text, bold)) {
    if (!html) out += p.type === 'url' && p.shown ? `${p.shown} [${p.value}]` : p.value
    else if (p.type === 'url') out += `<a href="${esc(p.value)}">${esc(p.shown ?? p.value)}</a>`
    else if (p.type === 'email') out += `<a href="mailto:${esc(p.value)}">${esc(p.value)}</a>`
    else if (p.type === 'bold') out += `<strong>${esc(p.value)}</strong>`
    else out += esc(p.value)
  }
  return out
}

const MODES = {
  html: esc,
  raw: (s) => s,
  uri,
  human: (s) => human(s, false, true),
  humanBold: (s) => human(s, true, true),
  humanText: (s) => human(s, false, false),
  humanBoldText: (s) => human(s, true, false),
}

const isSet = (v) => v === true || (typeof v === 'string' && v !== '')

/**
 * Runs one program. `values[i]` is a string, a boolean (a flag), or missing.
 */
function run(ops, values) {
  let out = ''
  let pending = 0
  const put = (s) => {
    if (!s) return
    if (pending && out) out += '\n'.repeat(pending)
    pending = 0
    out += s
  }
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    switch (op[0]) {
      case 'lit': put(op[1]); break
      case 'slot': {
        const v = values[op[1]]
        if (typeof v === 'string' && v) put(MODES[op[2]](v))
        break
      }
      case 'jz': if (!op[1].every((k) => isSet(values[k]))) i = op[2] - 1; break
      case 'jmp': i = op[1] - 1; break
      case 'brk': pending = Math.max(pending, op[1]); break
    }
  }
  return out
}

export { esc, human, humanParts, isSet, MODES, run, uri }
