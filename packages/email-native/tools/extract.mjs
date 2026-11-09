// The importer's pug half: legacy's templates (templates/<name>/*.pug, locales/*.json)
// rendered with sentinels where the values go, once per locale and per value set of
// the MJML translation -- so tools/compare_pug.mjs can hold the two to each other on
// what a reader sees. Not part of the build. Output: <out>/ir.json
//
// pug has no branches the importer could keep, so here a value set is a rendering of
// its own: renders[kind][locale][set] = ops, in the format of tools/runtime.mjs.
//
//   bun tools/extract.mjs --mjml build/tools/mjml/ir.json --out build/tools/pug
import { convert } from 'html-to-text'
import pug from 'pug'
import fs from 'node:fs'
import path from 'node:path'
import { LOCALE_DIR, LOCALES, OUT_DIR, TEMPLATE_ROOT, TEXT_OPTIONS_PUG as TEXT_OPTIONS } from './manifest.mjs'
import { program, tok } from './markers.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const MJML_IR = path.resolve(arg('mjml', path.join(TEMPLATE_ROOT, '..', 'build', 'tools', 'mjml', 'ir.json')))

// ---------------------------------------------------------------- i18n
const flatten = (o, p = '') =>
  Object.entries(o).reduce((acc, [k, v]) => {
    if (v && typeof v === 'object') Object.assign(acc, flatten(v, `${p + k}.`))
    else acc[p + k] = v
    return acc
  }, {})

const catalogs = Object.fromEntries(
  LOCALES.map((l) => [l, flatten(JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, `${l}.json`), 'utf8')))]),
)

// i18n is configured with mustacheConfig.tags = ['{','}'] (locales/localization.ts)
function makeT(locale) {
  const cat = catalogs[locale]
  return (key, params) => {
    let s = cat[key] ?? catalogs.en[key]
    if (s === undefined) throw new Error(`missing translation ${locale}:${key}`)
    if (params) s = s.replace(/\{([A-Za-z0-9_]+)\}/g, (m, k) => (k in params ? String(params[k]) : m))
    return s
  }
}

// ---------------------------------------------- values as legacy's code sees them
const slot = (name, mode = 'v') => tok(`$${mode}:${name}`)

/*
 * legacy's helpers, given the sentinels instead of values. humanTextParts hands its
 * text back whole with every value in it marked as a person's text -- per value, which
 * is what the C does; the phrases around a value carry no addresses. encodeURIComponent
 * marks the value as a URI component instead of encoding the sentinel away.
 */
const helpers = {
  humanTextParts: (text, options) => [
    { type: 'text', value: String(text ?? '').replace(/\u0001\$v:/g, `\u0001$${options?.bold ? 'hb' : 'h'}:`) },
  ],
  encodeURIComponent: (v) => String(v).replace(/\u0001\$v:/g, '\u0001$u:'),
}

// pug compiles to `(function (a, b, t, ...) {...}`, the identifiers the template uses.
function pugVars(fn) {
  const m = /\(function \(([^)]*)\)/.exec(fn.toString())
  return m[1].split(',').map((s) => s.trim()).filter(Boolean)
}

// ------------------------------------------------------------------ build
if (!fs.existsSync(MJML_IR)) {
  console.error(`no ${MJML_IR} -- the value sets come from there: bun run extract:mjml`)
  process.exit(1)
}
const mjml = JSON.parse(fs.readFileSync(MJML_IR, 'utf8'))
const ir = { locales: LOCALES, templates: [] }
const problems = []

for (const t of mjml.templates) {
  const dir = path.join(TEMPLATE_ROOT, t.name)
  if (!fs.existsSync(path.join(dir, 'html.pug'))) {
    console.error(`  ${t.name.padEnd(32)} no pug source, skipped`)
    continue
  }
  try {
    const compile = (file) => pug.compileFile(path.join(dir, file), { basedir: TEMPLATE_ROOT, filename: path.join(dir, file) })
    const fns = { html: compile('html.pug'), subject: compile('subject.pug') }
    const vars = [...new Set([...pugVars(fns.html), ...pugVars(fns.subject)])]
    const renders = { html: [], subject: [], text: [] }

    for (const locale of LOCALES) {
      for (const kind of ['html', 'subject', 'text']) renders[kind].push([])
      for (const cleared of t.valueSets) {
        const locals = { t: makeT(locale), locale: slot('locale'), language: slot('locale'), ...helpers }
        for (const v of vars) if (!(v in locals)) locals[v] = t.flags.includes(v) ? true : slot(v)
        for (const name of cleared) locals[name] = t.flags.includes(name) ? false : null
        // legacy hands the link's validity over as one object; the slots are its leaves
        locals.timeDurationObject = { hours: locals.hours ?? slot('hours'), minutes: locals.minutes === null ? 0 : slot('minutes') }

        const html = fns.html(locals)
        if (/undefined|\[object Object\]/.test(html)) throw new Error(`${locale}: 'undefined' or '[object Object]' in the output`)
        const where = `${t.name}/${locale}`
        renders.html.at(-1).push(program(html, 'html', where))
        renders.subject.at(-1).push(program(fns.subject(locals).trim(), 'subject', where))
        renders.text.at(-1).push(program(convert(html, TEXT_OPTIONS).trim(), 'text', where))
      }
    }
    ir.templates.push({ name: t.name, renders })
    console.error(`  ${t.name.padEnd(32)} ${t.valueSets.length} value set(s) x ${LOCALES.length} locales`)
  } catch (e) {
    problems.push(`${t.name}: ${e.message.split('\n')[0]}`)
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
