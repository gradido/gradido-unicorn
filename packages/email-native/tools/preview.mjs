/*
 * The preview: every locale and every variant of a template, in a browser, with
 * the slot values editable.
 *
 * It renders nothing itself. The page carries tools/runtime.mjs verbatim -- the op
 * machine src/render.c is held to -- and runs the programs of build/tools/mjml/ir.json
 * through it. Switching a locale, emptying a value or unticking a flag costs no round
 * trip, and what you look at is what the C would send.
 *
 * That is also why it is a third consumer of the IR and not a second renderer:
 *
 *   ir.json ─┬─► gen_c.mjs   ──► templates.c   what is sent
 *            ├─► verify.mjs  ──► the check     that C agrees
 *            └─► preview.mjs ──► this page     what you look at
 *
 *   bun tools/preview.mjs               build/tools/preview/{index.html,<name>.json}
 *   node tools/preview.mjs --inline     one self-contained .html per template
 *
 * `--inline` is for handing a page to somebody: data embedded, no server, no
 * fetch. The served form is the working tool -- scripts/preview.ts adds the watch.
 *
 * The literals are pooled per template the way gen_c.mjs pools them for C: 40
 * documents of the same mail share almost every byte, and storing them whole would
 * make a 1.4 MB page out of a 200 KB one.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const IR = path.resolve(arg('ir', path.join(ROOT, 'build', 'tools', 'mjml', 'ir.json')))
const OUT = path.resolve(arg('out', path.join(ROOT, 'build', 'tools', 'preview')))
const INLINE = process.argv.includes('--inline')

/** One template's programs, with the literals pooled per template. */
export function pack(t, locales) {
  const pool = []
  const index = new Map()
  const intern = (s) => {
    let i = index.get(s)
    if (i === undefined) { i = pool.length; pool.push(s); index.set(s, i) }
    return i
  }
  const docs = {}
  for (const kind of ['html', 'text', 'subject'])
    docs[kind] = t.renders[kind].map((ops) => ops.map((op) => (op[0] === 'lit' ? ['lit', intern(op[1])] : op)))
  return { name: t.name, values: t.values, slots: t.slots, flags: t.flags, valueSets: t.valueSets, locales, pool, docs }
}

/** What the page runs: tools/runtime.mjs as it is, minus its export line. */
export const RUNTIME = fs
  .readFileSync(path.join(ROOT, 'tools', 'runtime.mjs'), 'utf8')
  .replace(/^export \{[^}]*\}\n?/m, '')

/**
 * The page itself is a file, not a template literal: it contains backticks and
 * ${} of its own, and escaping those inside a JS template string is a good way to
 * introduce a bug that only shows up in the browser.
 */
const PAGE = (bootstrap) =>
  fs.readFileSync(path.join(ROOT, 'tools', 'preview-page.html'), 'utf8')
    .replace('__RUNTIME__', () => RUNTIME)
    .replace('__BOOTSTRAP__', () => bootstrap)


// ------------------------------------------------------------------------ write
// Only when run, never when imported: tests/preview.test.mjs pulls pack() out of
// here and must not have files written under it as a side effect.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()

function main() {
if (!fs.existsSync(IR)) {
  console.error(`no ${path.relative(ROOT, IR)} -- run: bun run extract:mjml`)
  process.exit(1)
}
const ir = JSON.parse(fs.readFileSync(IR, 'utf8'))
const samples = JSON.parse(fs.readFileSync(path.join(ROOT, '.preview-values.json'), 'utf8'))

fs.mkdirSync(OUT, { recursive: true })
const names = ir.templates.map((t) => t.name)
const packed = Object.fromEntries(ir.templates.map((t) => [t.name, pack(t, ir.locales)]))

if (INLINE) {
  for (const name of names) {
    const boot = { names: [name], inline: true, samples, templates: { [name]: packed[name] } }
    fs.writeFileSync(path.join(OUT, `${name}.html`), PAGE(JSON.stringify(boot)))
  }
  console.log(`${names.length} self-contained pages in ${path.relative(ROOT, OUT)}`)
} else {
  for (const name of names)
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(packed[name]))
  fs.writeFileSync(path.join(OUT, 'index.html'), PAGE(JSON.stringify({ names, inline: false, samples })))
  const kb = (f) => fs.statSync(path.join(OUT, f)).size / 1024
  const biggest = names.map((n) => [n, kb(`${n}.json`)]).sort((a, b) => b[1] - a[1])[0]
  console.log(
    `${names.length} templates in ${path.relative(ROOT, OUT)}` +
      ` -- index.html ${kb('index.html').toFixed(0)} KB,` +
      ` largest data ${biggest[0]} ${biggest[1].toFixed(0)} KB`,
  )
}
}
