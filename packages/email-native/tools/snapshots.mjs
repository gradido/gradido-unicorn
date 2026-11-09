/*
 * Writes tests/__snapshots__ out of build/tools/mjml/ir.json.
 *
 *   bun run snapshots:update
 *
 * Same idea, same value: the snapshots are how a change becomes VISIBLE. An edited
 * template, a corrected translation or an MJML upgrade shows up as a diff over
 * exactly the documents it reached and over nothing else. Read that diff -- it is
 * the review.
 *
 * It renders through tools/runtime.mjs, the op machine src/render.c is held to, with
 * the value sets of tools/values.mjs -- so what lands on disk is a finished mail and
 * not an intermediate form.
 *
 * These are what `zig build check` holds the C binary to, and what
 * tests/snapshots.test.mjs holds the extractor to. Nothing compares an
 * implementation against itself: the snapshots come from the JS side, the C is
 * measured against them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SNAPSHOT_DIR } from './manifest.mjs'
import { run } from './runtime.mjs'
import { valueVector } from './values.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const IR = path.resolve(arg('ir', path.join(ROOT, 'build', 'tools', 'mjml', 'ir.json')))
const OUT = path.resolve(arg('out', SNAPSHOT_DIR))

const walk = (dir, prefix = '') =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name), path.join(prefix, e.name)) : [path.join(prefix, e.name)],
      )
    : []

if (!fs.existsSync(IR)) {
  console.error(`no ${path.relative(ROOT, IR)} -- run: bun run extract:mjml`)
  process.exit(1)
}
const ir = JSON.parse(fs.readFileSync(IR, 'utf8'))

const before = new Set(walk(OUT))
const written = new Set()
let changed = 0

for (const t of ir.templates) {
  t.valueSets.forEach((_, set) => {
    ir.locales.forEach((locale, li) => {
      const values = valueVector(t, set, locale)
      for (const kind of ['html', 'subject', 'text']) {
        const rel = path.join(t.name, `${locale}.${set}.${kind}`)
        // No trailing newline: tools/dump.c writes the document and nothing else,
        // and tools/verify.mjs compares byte for byte.
        const body = Buffer.from(run(t.renders[kind][li], values), 'utf8')
        written.add(rel)
        const file = path.join(OUT, rel)
        // An unchanged file is left alone, so `git status` after an update names
        // exactly the documents a change reached.
        if (before.has(rel) && fs.readFileSync(file).equals(body)) continue
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, body)
        changed++
      }
    })
  })
}

let removed = 0
for (const stale of before) {
  if (written.has(stale)) continue
  fs.rmSync(path.join(OUT, stale))
  removed++
}

console.log(
  `${written.size} documents in ${path.relative(ROOT, OUT)}` +
    ` -- ${changed} written, ${removed} removed, ${written.size - changed} unchanged`,
)
if (changed || removed) console.log('now read `git diff` over them: that is the review.')
