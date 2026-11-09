/*
 * The markers of a template, on their own so they can be tested without running an
 * extraction: what an author writes, the tokens MJML carries through untouched, and
 * the ops tools/runtime.mjs and src/render.c execute.
 *
 *   {{t:Hello %1,|firstName}}   a message; %n filled from the names after the |
 *   {{v:name}}                  a value, HTML-escaped
 *   {{u:name}}                  a value as one URI component (encodeURIComponent)
 *   {{h:name}} {{hb:name}}      text a person typed: addresses become links,
 *                               with hb **bold** too (legacy's humanText)
 *   {{if a && b}} {{elif c}} {{else}} {{end}}
 *
 * A message argument takes the same prefixes, {{t:Message: %1|h:transactionMemo}}, and
 * optionally a wrapper from WRAPPERS around the value in the HTML part:
 * {{t:Your thank-you to %1|recipientAlias/whole}}.
 * A branch marker alone on its line becomes an <mj-raw>, so MJML places it between two
 * elements; inside an mj-text it is written inline.
 */

// U+0001 / U+0002 occur in no HTML or CSS, and neither MJML nor its minifier nor
// html-to-text touches them.
const SOT = '\u0001'
const EOT = '\u0002'
export const tok = (s) => SOT + s + EOT
export const TOKEN = /\u0001([^\u0001\u0002]*)\u0002/

/*
 * Markup around a value inside a message, where the message decides where the value
 * stands and the template cannot split it. HTML part only.
 *
 *   whole   the value moves to the next line as one piece, and breaks inside only
 *           where it is wider than the line by itself (legacy's span.alias)
 */
export const WRAPPERS = {
  whole: (s) =>
    `<span class="alias" style="display: inline-block; max-width: 100%; overflow-wrap: anywhere;">${s}</span>`,
}

const T_RE = /\{\{t:([^|{}]+)(?:\|([^{}]*))?\}\}/g
const V_RE = /\{\{(v|u|h|hb):([A-Za-z0-9_]+)\}\}/g
const BRANCH_RE = /\{\{(if|elif|else|end)(?:\s+([^{}]*?))?\s*\}\}/g
const BRANCH_LINE = /^[ \t]*(\{\{(?:if|elif|else|end)(?:\s+[^{}]*?)?\s*\}\})[ \t]*$/

/** "a && b" -> "a&&b", checked. */
const condition = (src, where) => {
  const names = (src ?? '').split('&&').map((s) => s.trim())
  for (const n of names)
    if (!/^[A-Za-z0-9_]+$/.test(n)) throw new Error(`${where}: '${src}' is not a condition (names joined by &&)`)
  return names.join('&&')
}

const branch = (kind, cond, where) =>
  tok(kind === 'if' ? `?${condition(cond, where)}` : kind === 'elif' ? `:${condition(cond, where)}` : kind === 'else' ? '!' : '/')

/**
 * The preprocessor MJML runs on the template and on every include. Comments go first:
 * they are documentation, and the header of a template SHOWS example markers that must
 * not become real ones. A message becomes an id, so MJML's minifier never sees its text;
 * `messages` collects them, { ids: Map, list: [{ msgid, slots: [{ token, html }] }] }.
 */
export function prepare(xml, messages, where) {
  return xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((line) => {
      const m = BRANCH_LINE.exec(line)
      if (!m) return line
      BRANCH_RE.lastIndex = 0
      const [, kind, cond] = BRANCH_RE.exec(m[1])
      return `<mj-raw>${branch(kind, cond, where)}</mj-raw>`
    })
    .join('\n')
    .replace(BRANCH_RE, (_, kind, cond) => branch(kind, cond, where))
    .replace(V_RE, (_, mode, name) => tok(`$${mode}:${name}`))
    .replace(T_RE, (_, msgid, args) => {
      const key = `${msgid}|${args ?? ''}`
      let id = messages.ids.get(key)
      if (id === undefined) {
        id = messages.list.length
        messages.ids.set(key, id)
        const slots = (args ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((a) => {
          const m = /^(?:(v|u|h|hb):)?([A-Za-z0-9_]+)(?:\/([a-z]+))?$/.exec(a)
          if (!m || (m[3] && !WRAPPERS[m[3]])) throw new Error(`${where}: '${a}' is not a message argument`)
          const token = tok(`$${m[1] ?? 'v'}:${m[2]}`)
          return { token, html: m[3] ? WRAPPERS[m[3]](token) : token }
        })
        messages.list.push({ msgid, slots })
      }
      return tok(`t${id}`)
    })
}

const BRANCH_TOKEN = '\\u0001[?:!/][^\\u0002]*\\u0002'

/**
 * MJML as if the markers were not there. Between two sections it would merge the
 * Outlook-only comments that close one table and open the next; an <mj-raw> between
 * them keeps them apart. Merging them around the marker puts the marker inside the
 * comment -- harmless, since either way the jump lands between two whole tags. And the
 * whitespace after a marker goes, so that a taken branch and a skipped one each leave
 * the single space the minifier wrote.
 */
export const besideMarkers = (html) =>
  html
    .replace(new RegExp(`<!\\[endif\\]-->\\s*((?:${BRANCH_TOKEN}\\s*)+)<!--\\[if mso \\| IE\\]>`, 'g'), (_, m) =>
      m.replace(/\s+/g, ''),
    )
    .replace(new RegExp(`(${BRANCH_TOKEN})\\s+`, 'g'), '$1')

/**
 * The line breaks html-to-text puts around a block are written next to the block's
 * markers -- and have to go with the block when it is skipped. So in the text part a
 * run of them beside a marker becomes a `brk` token, merged by max at runtime the way
 * html-to-text merges block breaks.
 */
export const breaksAsTokens = (text) =>
  text.replace(new RegExp(`(\\n*)(${BRANCH_TOKEN})(\\n*)`, 'g'), (_, a, m, b) =>
    (a ? tok(`#${a.length}`) : '') + m + (b ? tok(`#${b.length}`) : ''),
  )

const HTML_MODE = { v: 'html', u: 'uri', h: 'human', hb: 'humanBold' }
const TEXT_MODE = { v: 'raw', u: 'uri', h: 'humanText', hb: 'humanBoldText' }

/**
 * A string with tokens in it -> ops, with names still in place of value indices.
 * `kind` is html, subject or text; the last two take a value as text.
 */
export function program(s, kind, where) {
  const ops = []
  const stack = []
  const parts = s.split(TOKEN)
  const patch = (list, to) => {
    for (const i of list) ops[i][2] = to
  }
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) ops.push(['lit', parts[i]])
      continue
    }
    const t = parts[i]
    if (t[0] === '#') {
      ops.push(['brk', +t.slice(1)])
    } else if (t[0] === '$') {
      const [mode, name] = t.slice(1).split(':')
      ops.push(['slot', name, (kind === 'html' ? HTML_MODE : TEXT_MODE)[mode]])
    } else if (t[0] === '?' || t[0] === ':') {
      if (t[0] === '?') stack.push({ next: [], ends: [], hasElse: false })
      const f = stack.at(-1)
      if (!f) throw new Error(`${where}: {{elif}} without {{if}}`)
      if (t[0] === ':') {
        if (f.hasElse) throw new Error(`${where}: {{elif}} after {{else}}`)
        f.ends.push(ops.length)
        ops.push(['jmp', null])
        patch(f.next, ops.length)
      }
      // One jz per name: `a && b` is two of them to the same place.
      f.next = t.slice(1).split('&&').map((name) => ops.push(['jz', [name], null]) - 1)
    } else if (t === '!') {
      const f = stack.at(-1)
      if (!f || f.hasElse) throw new Error(`${where}: stray {{else}}`)
      f.hasElse = true
      f.ends.push(ops.length)
      ops.push(['jmp', null])
      patch(f.next, ops.length)
      f.next = []
    } else if (t === '/') {
      const f = stack.pop()
      if (!f) throw new Error(`${where}: {{end}} without {{if}}`)
      patch(f.next, ops.length)
      for (const j of f.ends) ops[j][1] = ops.length
    } else if (t[0] === 't') {
      throw new Error(`${where}: a message was not translated`)
    } else throw new Error(`${where}: unknown marker ${JSON.stringify(t)}`)
  }
  if (stack.length) throw new Error(`${where}: ${stack.length} {{if}} without {{end}}`)
  return ops
}

/** The branches of a document, in order, as chains of conditions (each a list of names). */
export function chains(s) {
  const out = []
  const stack = []
  for (const [, t] of s.matchAll(new RegExp(TOKEN, 'g'))) {
    if (t[0] === '?') {
      const c = { conds: [t.slice(1).split('&&')] }
      out.push(c)
      stack.push(c)
    } else if (t[0] === ':') stack.at(-1).conds.push(t.slice(1).split('&&'))
    else if (t === '/') stack.pop()
  }
  return out
}

/**
 * One value set per case of every branch, rather than every combination: set 0 has
 * everything set, and each further set clears what it takes to reach one other case.
 * Every jump is then taken and not taken at least once. A set is the list of names
 * left unset.
 */
export function valueSets(branchChains) {
  const sets = [[]]
  const seen = new Set([''])
  for (const c of branchChains) {
    // Case k: the conditions before it fail. The last case is the else, written or empty.
    for (let k = 1; k <= c.conds.length; k++) {
      const keep = c.conds[k] ?? []
      const cleared = [...new Set(c.conds.slice(0, k).flat())].filter((n) => !keep.includes(n))
      const key = [...cleared].sort().join(',')
      if (seen.has(key)) continue
      seen.add(key)
      sets.push(cleared)
    }
  }
  return sets
}
