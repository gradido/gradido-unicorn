/*
 * Does the preview show what ships?
 *
 * The page runs the programs through tools/runtime.mjs, pasted in verbatim. If the
 * page ran anything else, the preview would become a picture of a mail nobody sends --
 * the one failure that would make the tool worse than useless. So this checks two
 * things: the page is built with that source and no other, and that source, run the
 * way the page runs it -- over pack()'s pooled literals, compiled from text -- renders
 * the snapshots.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SNAPSHOT_DIR as SNAP } from '../tools/manifest.mjs'
import { pack, RUNTIME } from '../tools/preview.mjs'
import { valueVector } from '../tools/values.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IR = path.join(ROOT, 'build', 'tools', 'mjml', 'ir.json')

const ready = fs.existsSync(IR) && fs.existsSync(SNAP)

test('the page carries the runtime and nothing in its place', () => {
  const page = fs.readFileSync(path.join(ROOT, 'tools', 'preview-page.html'), 'utf8')
  assert.equal(page.split('__RUNTIME__').length, 2, 'the page has one place for the runtime')
  assert.ok(!/function run\(|const esc =/.test(page), 'the page renders with code of its own')
})

test('the preview renders what the snapshots say', { skip: ready ? false : 'run: bun run snapshots:update' }, () => {
  const run = new Function(`${RUNTIME}\nreturn run`)()
  const ir = JSON.parse(fs.readFileSync(IR, 'utf8'))

  let checked = 0
  for (const t of ir.templates) {
    const p = pack(t, ir.locales)
    t.valueSets.forEach((_, set) => {
      ir.locales.forEach((locale, li) => {
        const values = valueVector(t, set, locale)
        for (const kind of ['html', 'text', 'subject']) {
          const ops = p.docs[kind][li].map((op) => (op[0] === 'lit' ? ['lit', p.pool[op[1]]] : op))
          const want = fs.readFileSync(path.join(SNAP, t.name, `${locale}.${set}.${kind}`), 'utf8')
          assert.equal(run(ops, values), want, `${t.name}/${locale}.${set}.${kind}`)
          checked++
        }
      })
    })
  }
  assert.ok(checked > 0)
})
