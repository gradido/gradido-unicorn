/*
 * The branch markers and the jumps they become, without an extraction.
 *
 * A defect here is a mail with a block missing or one too many, in every locale at
 * once -- so each shape is run through tools/runtime.mjs, the machine src/render.c is
 * held to, rather than inspected as a list of ops.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { breaksAsTokens, chains, prepare, program, tok, valueSets } from '../tools/markers.mjs'
import { run } from '../tools/runtime.mjs'

/** Template text -> what it renders to, values by name. */
function render(src, values, kind = 'html') {
  const messages = { ids: new Map(), list: [] }
  let s = prepare(src, messages, 'test').replace(/<\/?mj-raw>/g, '')
  if (kind === 'text') s = breaksAsTokens(s)
  const ops = program(s, kind, 'test')
  const names = []
  for (const op of ops) {
    if (op[0] === 'slot' && !names.includes(op[1])) names.push(op[1])
    if (op[0] === 'jz') for (const n of op[1]) if (!names.includes(n)) names.push(n)
  }
  const at = (n) => names.indexOf(n)
  const indexed = ops.map((op) =>
    op[0] === 'slot' ? ['slot', at(op[1]), op[2]] : op[0] === 'jz' ? ['jz', op[1].map(at), op[2]] : op,
  )
  return run(indexed, names.map((n) => values[n]))
}

test('if / elif / else picks exactly one case', () => {
  const src = 'A{{if x}}X{{elif y}}Y{{else}}Z{{end}}B'
  assert.equal(render(src, { x: true, y: true }), 'AXB')
  assert.equal(render(src, { y: 'set' }), 'AYB')
  assert.equal(render(src, {}), 'AZB')
})

test('an if without an else has an empty last case', () => {
  assert.equal(render('A{{if x}}X{{end}}B', { x: '1' }), 'AXB')
  assert.equal(render('A{{if x}}X{{end}}B', { x: '' }), 'AB')
})

test('a && b needs both', () => {
  const src = '{{if a && b}}AB{{else}}-{{end}}'
  assert.equal(render(src, { a: '1', b: '1' }), 'AB')
  assert.equal(render(src, { a: '1' }), '-')
  assert.equal(render(src, { b: '1' }), '-')
})

test('branches nest', () => {
  const src = '{{if a}}A{{if b}}B{{else}}b{{end}}{{else}}-{{end}}.'
  assert.equal(render(src, { a: '1', b: '1' }), 'AB.')
  assert.equal(render(src, { a: '1' }), 'Ab.')
  assert.equal(render(src, { b: '1' }), '-.')
})

test('a marker alone on its line becomes an mj-raw, one in a line stays inline', () => {
  const messages = { ids: new Map(), list: [] }
  assert.equal(prepare('  {{if x}}\n<p>{{end}}</p>', messages, 't'), `<mj-raw>${tok('?x')}</mj-raw>\n<p>${tok('/')}</p>`)
})

test('the blank line around a skipped block goes with it in the text part', () => {
  const src = 'A\n\n{{if x}}\n\nX\n\n{{end}}\n\nB'
  assert.equal(render(src, { x: '1' }, 'text'), 'A\n\nX\n\nB')
  assert.equal(render(src, {}, 'text'), 'A\n\nB')
  // and none is left at the start or the end
  assert.equal(render('{{if x}}\n\nX\n\n{{end}}\n\nB', {}, 'text'), 'B')
  assert.equal(render('A\n\n{{if x}}\n\nX{{end}}', {}, 'text'), 'A')
})

test('modes: a value is escaped, a URI component encoded', () => {
  assert.equal(render('<a href="/c?w={{u:id}}">{{v:id}}</a>', { id: 'a&b c' }), '<a href="/c?w=a%26b%20c">a&amp;b c</a>')
})

test('one value set per case, not per combination', () => {
  const s = prepare('{{if a}}{{end}}{{if b}}{{elif c}}{{end}}{{if d && e}}{{end}}', { ids: new Map(), list: [] }, 't')
  assert.deepEqual(valueSets(chains(s)), [[], ['a'], ['b'], ['b', 'c'], ['d', 'e']])
})

test('unbalanced markers throw rather than guess', () => {
  for (const src of ['{{if a}}', '{{end}}', '{{else}}', '{{if a}}{{else}}{{elif b}}{{end}}', '{{if a}}{{else}}{{else}}{{end}}']) {
    assert.throws(() => program(prepare(src, { ids: new Map(), list: [] }, 't'), 'html', 't'), src)
  }
  assert.throws(() => prepare('{{if a ||b}}', { ids: new Map(), list: [] }, 't'))
})
