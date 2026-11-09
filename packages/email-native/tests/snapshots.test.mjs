/*
 * The extractor renders today what the snapshots say.
 *
 * This is the first of the three that hold the C honest, and the only one that
 * does not involve C at all:
 *
 *   tests/snapshots.test.mjs   the extractor renders what the snapshots say
 *   tests/preview.test.mjs     the preview page renders what the snapshots say
 *   zig build check            the C binary renders what the snapshots say
 *
 * None of them compares an implementation against itself. This one is what keeps
 * the reference honest -- an MJML upgrade, an edited template or a corrected
 * translation shows up here first, as a diff over exactly the documents it
 * reached. Read that diff and then run `bun run snapshots:update`; the other way
 * round the review has already happened without you.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SNAPSHOT_DIR } from '../tools/manifest.mjs'
import { run } from '../tools/runtime.mjs'
import { valueVector } from '../tools/values.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IR = path.join(ROOT, 'build', 'tools', 'mjml', 'ir.json')

const walk = (dir, prefix = '') =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), path.join(prefix, e.name)) : [path.join(prefix, e.name)],
  )

const ready = fs.existsSync(IR)

test('the extractor renders what the snapshots say', { skip: ready ? false : 'run: bun run extract:mjml' }, () => {
  const ir = JSON.parse(fs.readFileSync(IR, 'utf8'))
  const onDisk = new Set(walk(SNAPSHOT_DIR))
  const seen = new Set()
  const problems = []

  for (const t of ir.templates) {
    t.valueSets.forEach((_, set) => {
      ir.locales.forEach((locale, li) => {
        for (const kind of ['html', 'text', 'subject']) {
          const rel = path.join(t.name, `${locale}.${set}.${kind}`)
          seen.add(rel)
          if (!onDisk.has(rel)) { problems.push(`${rel}: no snapshot`); continue }
          const want = fs.readFileSync(path.join(SNAPSHOT_DIR, rel), 'utf8')
          if (run(t.renders[kind][li], valueVector(t, set, locale)) !== want)
            problems.push(`${rel}: renders something else now`)
        }
      })
    })
  }
  for (const stale of onDisk) if (!seen.has(stale)) problems.push(`${stale}: snapshot with no document`)

  assert.deepEqual(
    problems,
    [],
    `${problems.length} document(s) differ -- run \`bun run snapshots:update\` and read the diff`,
  )
})
