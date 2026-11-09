/*
 * A person's text in a mail: the addon's C tokenizer (ge_put_human in src/render.c)
 * against tools/runtime.mjs, which runs legacy's regular expressions as they are.
 *
 * The C reproduces three regular expressions by hand, and a hand-written matcher is
 * exactly where a corner goes wrong unnoticed -- so besides the cases legacy tests,
 * random text over the characters the patterns care about is thrown at both.
 *
 * customEmail carries both modes: the subject as a person's text, the memo with bold.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { humanParts, run } from '../tools/runtime.mjs'
import { valueVector } from '../tools/values.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IR = path.join(ROOT, 'build', 'tools', 'mjml', 'ir.json')
const email = createRequire(import.meta.url)('../index.cjs')
const ready = fs.existsSync(IR)

const ROOM = 'https://meet.weimarnetz.de/idpdd16o81l0'
const CASES = [
  // legacy's own (core/src/logic/HumanText.logic.test.ts)
  'Shall we meet at ten?',
  'Room: https://virtual.chaosdorf.space/0mw1hppxkzme.',
  'write to a@b.de please',
  'https://x.org/?to=a@b.de',
  'javascript:alert(1)',
  '<img src=x onerror=alert(1)> https://x.org',
  'one\nhttps://x.org\ntwo',
  `Der Raum: ${ROOM}#config.subject=%22Videoanruf%22&gradido.start=1790686800&gradido.end=1790690400`,
  `${ROOM}#config.subject=%22Lesekreis%22`,
  'https://x.org/a#section',
  `${ROOM}#config.subject=%22x%22&config.startWithAudioMuted=true`,
  `${ROOM}#config.subject=%22x%22&gradido.start=1790686800`,
  `${ROOM}#config.subject=%22x%22&gradido.start=9999999999999&gradido.end=99999999999999`,
  `${ROOM}#config.subject=%22x%22&gradido.start=999999999999&gradido.end=1`,
  `${ROOM}#a#config.subject=%22x%22`,
  `${ROOM}#config.subject=`,
  'We meet **at ten**, ok?',
  '**one\ntwo** and **three**',
  '**https://x.org** *half',
  // the corners of the hand-written matcher
  'HTTPS://X.ORG/A', 'Https://x', 'xhttp://a.b', '_http://a.b', '1http://a.b', 'ähttp://a.b',
  'http://', 'http://.', 'https://a.', 'ftp://a', 'ftps://a', 'http:/a', 'httpss://a',
  'http://a.b/c,d;e!', 'http://a?b=1&c=2', '(http://a.b/c)', '"http://a"',
  'a.b@c.de', '.x@y.de', '..x@y.de', 'x.@y.de', 'x@y.d', 'x@y.d1', 'x@y.de1', 'x@y.de_', 'x@y.de-f',
  'a@b@c.de', 'a@b.c.de.f', 'a@b.cd.e1', 'üa@b.de', 'a@ü.de', '+a@b.de', '-a@b.de', 'a@-b.de',
  'mailto:a@b.cd', 'x@@y.de', '@y.de', 'x@.de', 'x@y..de',
  '**', '***', '****', '*****', '***x**', '** **', '**a', 'a**b**c**d**e', '**\n**',
  '',
]

/** The addon and the runtime, over one customEmail with `subject` and `memo` set to s. */
function both(t, s) {
  const v = valueVector(t, 0, 'de')
  v[t.values.indexOf('subject')] = s
  v[t.values.indexOf('memo')] = s
  const values = Object.fromEntries(t.values.slice(1).map((n, i) => [n, v[i + 1]]))
  const got = email.render('customEmail', 'de', values)
  const li = 1 // de
  return {
    got,
    want: { html: run(t.renders.html[li], v), text: run(t.renders.text[li], v) },
  }
}

test('the C tokenizer cuts as legacy does: the known cases', { skip: ready ? false : 'run: bun run extract:mjml' }, () => {
  const ir = JSON.parse(fs.readFileSync(IR, 'utf8'))
  const t = ir.templates.find((x) => x.name === 'customEmail')
  for (const s of CASES) {
    const { got, want } = both(t, s)
    assert.equal(got.html, want.html, `html of ${JSON.stringify(s)}: ${JSON.stringify(humanParts(s, true))}`)
    assert.equal(got.text, want.text, `text of ${JSON.stringify(s)}`)
  }
})

test('the C tokenizer cuts as legacy does: random text', { skip: ready ? false : 'run: bun run extract:mjml' }, () => {
  const ir = JSON.parse(fs.readFileSync(IR, 'utf8'))
  const t = ir.templates.find((x) => x.name === 'customEmail')
  const pieces = [
    'http', 'https', 'ftp', '://', 'HTTP', '@', '.', '..', '-', '_', '%', '+', '*', '**', '#', '&', '?', '=',
    ',', ';', '!', ':', '/', ' ', '\n', 'a', 'B', '1', 'de', 'org', 'ä', '"', '<',
    '#config.subject=', '&gradido.start=', '&gradido.end=', '123', 'mailto:',
  ]
  // A fixed generator, so a failure is the same failure on the next run.
  let seed = 0x9e3779b9
  const next = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 0x100000000
  }
  for (let i = 0; i < 3000; i++) {
    let s = ''
    const n = 1 + Math.floor(next() * 14)
    for (let k = 0; k < n; k++) s += pieces[Math.floor(next() * pieces.length)]
    const { got, want } = both(t, s)
    assert.equal(got.html, want.html, `html of ${JSON.stringify(s)}: ${JSON.stringify(humanParts(s, true))}`)
    assert.equal(got.text, want.text, `text of ${JSON.stringify(s)}`)
  }
})

test('nothing a person typed reaches the mail as markup', () => {
  const ir = JSON.parse(fs.readFileSync(IR, 'utf8'))
  const t = ir.templates.find((x) => x.name === 'customEmail')
  const { got } = both(t, '<script>x</script> "><img src=x> https://a.b/"<x> **<b>**')
  for (const raw of ['<script>', '"><img src=x>', '"<x>', '<b>'])
    assert.ok(!got.html.includes(raw), `${raw} arrived as markup`)
  assert.ok(got.html.includes('&lt;script&gt;x&lt;/script&gt;'))
  assert.ok(got.html.includes('<a href="https://a.b/">https://a.b/</a>&quot;&lt;x&gt;'))
  assert.ok(got.html.includes('<strong>&lt;b&gt;</strong>'))
})
