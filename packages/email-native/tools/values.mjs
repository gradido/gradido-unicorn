// The values the snapshots are rendered with.
//
// Per template a few value sets rather than every combination of its branches: set 0
// has everything set, and each further set leaves unset what it takes to reach one
// other case of one branch (tools/extract_mjml.mjs, valueSets). The sets travel in
// ir.json and, for tools/dump.c, in the generated test_sets.c -- one list, so the
// snapshots, the addon test and the C binary all mean the same thing by `de.2`.

/** Every character HTML escapes (& < > "), one it does not ('), a non-ASCII one, and what
 *  a person's text turns into a link, a shortened link, a link without its full stop, a
 *  mail link and bold. Identical to GE_FIXTURE in tools/dump.c. */
export const fixture = (name) =>
  `{${name}|&<>"'ä **b** https://x.example/r#config.subject=%22T%22 ftp://y.example/a. m@x.example}`

/**
 * The value vector of a template's programs for one set and locale -- what
 * tools/runtime.mjs `run` takes: [locale, ...slots, ...flags].
 */
export function valueVector(t, set, locale) {
  const cleared = new Set(t.valueSets[set])
  return t.values.map((name, i) => {
    if (i === 0) return locale
    const isFlag = i > t.slots.length
    if (cleared.has(name)) return isFlag ? false : ''
    return isFlag ? true : fixture(name)
  })
}

/** The same set as the object the addon's render() takes. */
export function valueObject(t, set) {
  const v = valueVector(t, set, '')
  return Object.fromEntries(t.values.slice(1).map((name, i) => [name, v[i + 1]]))
}
