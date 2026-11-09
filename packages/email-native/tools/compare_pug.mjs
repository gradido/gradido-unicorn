/*
 * What the rewrite changed about what a READER sees.
 *
 * Comparing the two HTML outputs byte for byte would say "everything differs" and
 * mean nothing: div-and-class against nested tables is the point of the exercise.
 * So this compares the three things that are supposed to have survived it:
 *
 *   subject   byte for byte. Same catalogue string, same slots -- a difference
 *             here is an error, never a consequence of the new markup.
 *   text      byte for byte. Both are html-to-text over the same content, so a
 *             difference is either a real content change or the tables leaking
 *             into the plain part. Both are worth seeing.
 *   html      as VISIBLE TEXT: tags dropped, entities decoded, whitespace
 *             collapsed. This is the question "did a sentence go missing", asked
 *             independently of how it is marked up.
 *
 * Both sides are filled with the value sets the snapshots use, through tools/runtime.mjs,
 * so what is compared is two finished documents and not two intermediate forms.
 *
 *   bun tools/extract_mjml.mjs  --out build/tools/mjml
 *   bun tools/extract.mjs       --out build/tools/pug
 *   bun tools/compare_pug.mjs  [--pug DIR] [--mjml DIR] [--diff DIR]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from './runtime.mjs'
import { valueVector } from './values.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const PUG = path.resolve(arg('pug', path.join(ROOT, 'build', 'tools', 'pug')))
const MJML = path.resolve(arg('mjml', path.join(ROOT, 'build', 'tools', 'mjml')))
const DIFF_DIR = path.resolve(arg('diff', path.join(ROOT, 'build', 'tools', 'diff')))

/** The pug side names its values; the MJML template says which index each one has. */
const indexed = (ops, values, missing) =>
  ops.map((op) => {
    const at = (n) => {
      const i = values.indexOf(n)
      if (i < 0) missing.add(n)
      return i
    }
    if (op[0] === 'slot') return ['slot', at(op[1]), op[2]]
    if (op[0] === 'jz') return ['jz', op[1].map(at), op[2]]
    return op
  })

const decode = (s) =>
  s
    .replace(/&(amp|lt|gt|quot|nbsp|#39|#x27|#8217|#8220|#8221);/g, (m, e) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', '#39': "'", '#x27': "'", '#8217': '’', '#8220': '“', '#8221': '”' })[e],
    )

/**
 * The visible text of an HTML document. Not a parser and not trying to be one:
 * <style> and comments go, tags become a space, entities are decoded, runs of
 * whitespace collapse. Enough to answer "is the same wording there".
 */
const visible = (html) =>
  decode(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(style|script|title)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()

/** The first place two strings part, with a little of each side around it. */
const firstDifference = (a, b) => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const from = Math.max(0, i - 40)
  return {
    at: i,
    pug: JSON.stringify(a.slice(from, i + 60)),
    mjml: JSON.stringify(b.slice(from, i + 60)),
  }
}

const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'ir.json'), 'utf8'))
for (const d of [PUG, MJML])
  if (!fs.existsSync(path.join(d, 'ir.json'))) {
    console.error(`no ir.json in ${d} -- see the header of this file for the two commands`)
    process.exit(1)
  }

const a = read(PUG)
const b = read(MJML)
const byName = (ir) => Object.fromEntries(ir.templates.map((t) => [t.name, t]))
const A = byName(a)
const B = byName(b)

fs.rmSync(DIFF_DIR, { recursive: true, force: true })
fs.mkdirSync(DIFF_DIR, { recursive: true })

/*
 * For the text part, "equal" has three useful meanings and only the third is a
 * finding. Both sides put stray blank lines where a block boundary happened to
 * fall -- pug after a .content div, MJML after a skipped social row -- and
 * neither pattern was ever decided by anyone. Driving the first number to 270
 * would mean reproducing pug's accidents, so what is watched is the third.
 */
const grade = (x, y) => {
  if (x === y) return 'exakt'
  const runs = (s) => s.replace(/\n{2,}/g, '\n\n')
  if (runs(x) === runs(y)) return 'nur Leerzeilen'
  const lines = (s) => s.split('\n').filter((l) => l.trim()).join('\n')
  if (lines(x) === lines(y)) return 'nur Leerzeilen'
  return 'INHALT'
}

const totals = { subject: [0, 0], text: [0, 0], html: [0, 0] }
const textGrades = new Map()
const rows = []

for (const name of Object.keys(A)) {
  if (!B[name]) { console.error(`  ${name}: only in the pug side`); continue }
  const counts = { subject: [0, 0], text: [0, 0], html: [0, 0] }
  const notes = []
  const missing = new Set()

  for (const kind of ['subject', 'text', 'html']) {
    const pa = A[name].renders[kind]
    const pb = B[name].renders[kind]
    for (let li = 0; li < pa.length; li++) {
      for (let vi = 0; vi < pa[li].length; vi++) {
        const doc = `${a.locales[li]}.${vi}`
        const values = valueVector(B[name], vi, a.locales[li])
        const sa = run(indexed(pa[li][vi], B[name].values, missing), values)
        const sb = run(pb[li], values)
        const [x, y] = kind === 'html' ? [visible(sa), visible(sb)] : [sa.trim(), sb.trim()]
        counts[kind][1]++
        totals[kind][1]++
        const g = kind === 'text' ? grade(x, y) : x === y ? 'exakt' : 'INHALT'
        if (kind === 'text') textGrades.set(g, (textGrades.get(g) ?? 0) + 1)
        if (x === y) { counts[kind][0]++; totals[kind][0]++; continue }
        // A text part that differs only in blank-line runs is not a finding.
        if (g === 'nur Leerzeilen') { counts[kind][0]++; totals[kind][0]++; continue }
        notes.push({ kind, doc, ...firstDifference(x, y) })
        const dir = path.join(DIFF_DIR, name)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, `${doc}.${kind}.pug.txt`), `${x}\n`)
        fs.writeFileSync(path.join(dir, `${doc}.${kind}.mjml.txt`), `${y}\n`)
      }
    }
  }
  if (missing.size) notes.unshift({ kind: 'values', doc: '-', at: 0, pug: [...missing].join(', '), mjml: '(nicht im MJML-Template)' })

  const cell = ([ok, all]) => (ok === all ? `${all}/${all}` : `${ok}/${all}`)
  rows.push([name, cell(counts.subject), cell(counts.text), cell(counts.html), notes])
}

const pad = (s, n) => String(s).padEnd(n)
console.log(`\n  ${pad('Template', 32)}${pad('subject', 10)}${pad('text', 10)}${pad('html (sichtbar)', 16)}`)
for (const [name, s, t, h, notes] of rows) {
  console.log(`  ${pad(name, 32)}${pad(s, 10)}${pad(t, 10)}${pad(h, 16)}${notes.length ? '  <-' : ''}`)
}
const line = (k) => `${totals[k][0]}/${totals[k][1]}`
console.log(`\n  inhaltlich gleich: subject ${line('subject')}   text ${line('text')}   html-sichtbar ${line('html')}`)
console.log(`  Textteil im Detail: ${[...textGrades].map(([g, n]) => `${g} ${n}`).join(', ')}`)

const withNotes = rows.filter(([, , , , n]) => n.length)
if (withNotes.length) {
  console.log('\n  Erste Abweichung je Template:')
  for (const [name, , , , notes] of withNotes) {
    const n = notes[0]
    console.log(`\n  ${name}  (${notes.length} Dokument(e), zuerst ${n.doc}, ${n.kind}, ab Zeichen ${n.at})`)
    console.log(`      pug : ${n.pug}`)
    console.log(`      mjml: ${n.mjml}`)
  }
  console.log(`\n  Vollständig in ${path.relative(ROOT, DIFF_DIR)}/<template>/<doc>.<kind>.{pug,mjml}.txt`)
} else {
  console.log('\n  Kein Unterschied im Inhalt.')
}
