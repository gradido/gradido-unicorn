/*
 * templates/<name>.mjml -> ir.json: per template and locale three programs (html,
 * subject, text) in the op format of tools/runtime.mjs.
 *
 *   templates/<name>.mjml ─┐ markers -> sentinels       (a preprocessor, so includes too)
 *   templates/includes/*   ─┘
 *                           ▼
 *                       mjml2html                       ONCE per template
 *                           ▼
 *   po/<lang>/messages.po ─► translations in            per locale: a string replace
 *                           ▼                           and html-to-text, no MJML
 *                       ops: lit / slot / jz / jmp / brk
 *
 * MJML runs once because everything that varies is opaque to it. A message is an id
 * until MJML is done, so its minifier never sees the text; a branch marker on a line of
 * its own goes into <mj-raw>, which MJML emits between two elements with its Outlook
 * wrappers closed on both sides -- so skipping what lies between two markers at
 * runtime leaves valid markup. Inside mj-text the content is passed through as it is,
 * and a marker there is simply inline.
 *
 * The markers an author writes, and what they become, are tools/markers.mjs. A name
 * that only ever appears in a condition is a flag -- a bool in the C struct.
 *
 *   node tools/extract_mjml.mjs [--out DIR] [--templates DIR] [--po DIR]
 */
import { convert } from 'html-to-text'
import mjml2html from 'mjml'
import fs from 'node:fs'
import path from 'node:path'
import { LOCALES, OUT_DIR, TEMPLATE_ROOT, TEMPLATES, TEXT_OPTIONS } from './manifest.mjs'
import { besideMarkers, breaksAsTokens, chains, prepare, program, valueSets } from './markers.mjs'
import { readPo, translationOf } from './po.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const PO_DIR = path.resolve(arg('po', path.join(TEMPLATE_ROOT, '..', 'po')))

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const unescapeHtml = (s) =>
  s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[e])

const catalogues = Object.fromEntries(LOCALES.map((l) => [l, readPo(path.join(PO_DIR, l, 'messages.po')).byId]))

/** The messages in, for one locale. html escapes the text, a header field does not. */
const translate = (s, messages, catalogue, html) =>
  s.replace(/\u0001t(\d+)\u0002/g, (_, id) => {
    const { msgid, slots } = messages.list[+id]
    if (!catalogue.has(msgid)) throw new Error(`no message for ${JSON.stringify(msgid)}`)
    const text = translationOf(catalogue, msgid)
    return (html ? escape(text) : text).replace(/%(\d+)/g, (m, n) =>
      slots[n - 1] ? (html ? slots[n - 1].html : slots[n - 1].token) : m,
    )
  })

// -------------------------------------------------------------------- build
const ir = { locales: LOCALES, templates: [] }
const problems = []

for (const name of TEMPLATES) {
  const file = path.join(TEMPLATE_ROOT, `${name}.mjml`)
  const messages = { ids: new Map(), list: [] }
  try {
    const source = fs.readFileSync(file, 'utf8')
    const title = /<mj-title>([\s\S]*?)<\/mj-title>/.exec(prepare(source, messages, name))
    if (!title) throw new Error('no <mj-title> to take the subject from')

    const r = await mjml2html(source, {
      filePath: file,
      ignoreIncludes: false,
      validationLevel: 'strict',
      preprocessors: [(xml) => prepare(xml, messages, name)],
      // The editor's config fills the markers with sample values; not here.
      useMjmlConfigOptions: false,
      minify: true,
    })
    if (r.errors.length) throw new Error(r.errors.map((e) => e.formattedMessage ?? e).join('; '))
    const html = besideMarkers(r.html)
    if (html.includes('mj-include denied')) throw new Error('an include was denied -- see accountActivation.mjml on includePath')
    if (/undefined|\[object Object\]/.test(html)) throw new Error("'undefined' or '[object Object]' in the output")

    const renders = { html: [], subject: [], text: [] }
    for (const locale of LOCALES) {
      const where = `${name}/${locale}`
      const h = translate(html, messages, catalogues[locale], true)
      // Three blank lines in a row are what a block html-to-text skips leaves behind
      // (the social row, the gold rule); one is what was meant.
      const text = convert(h, TEXT_OPTIONS).replace(/\n{3,}/g, '\n\n').trim()
      const subject = unescapeHtml(translate(title[1].trim(), messages, catalogues[locale], false))
      if (/\u0001[?:!/]/.test(subject)) throw new Error('a branch in the subject')
      renders.html.push(program(h, 'html', where))
      renders.subject.push(program(subject, 'subject', where))
      renders.text.push(program(breaksAsTokens(text), 'text', where))
    }

    // The names: slots in sorted order, then the flags in the order they appear.
    const slotNames = new Set()
    const condNames = []
    for (const kind of ['html', 'subject', 'text'])
      for (const ops of renders[kind])
        for (const op of ops) {
          if (op[0] === 'slot') slotNames.add(op[1])
          if (op[0] === 'jz') for (const n of op[1]) if (!condNames.includes(n)) condNames.push(n)
        }
    slotNames.delete('locale')
    const slots = [...slotNames].sort()
    const flags = condNames.filter((n) => !slotNames.has(n) && n !== 'locale')
    const values = ['locale', ...slots, ...flags]
    const index = new Map(values.map((n, i) => [n, i]))
    for (const kind of ['html', 'subject', 'text'])
      for (const ops of renders[kind])
        for (const op of ops) {
          if (op[0] === 'slot') op[1] = index.get(op[1])
          if (op[0] === 'jz') op[1] = op[1].map((n) => index.get(n))
        }

    const sets = valueSets(chains(translate(html, messages, catalogues.en, true)))
    ir.templates.push({ name, slots, flags, values, valueSets: sets, renders })
    console.error(`  ${name.padEnd(32)} ${slots.length} slots, ${flags.length} flags, ${sets.length} value set(s)`)
  } catch (e) {
    problems.push(`${name}: ${e.message.split('\n')[0]}`)
  }
}

if (problems.length) {
  console.error(`\nERROR:\n${problems.join('\n')}`)
  process.exit(1)
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const irPath = path.join(OUT_DIR, 'ir.json')
fs.writeFileSync(irPath, JSON.stringify(ir))
console.error(`\nwrote ${irPath} (${(fs.statSync(irPath).size / 1024).toFixed(0)} KB raw)`)
