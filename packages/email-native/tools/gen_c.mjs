// <out>/ir.json  ->  <out>/service_core/email/templates.h + <out>/templates.c
//                    (+ <out>/test_sets.c, for tools/dump.c only)
//
// The header sits under service_core/email/ so that the include spelling is the one
// fast-servers uses -- the two files are copied into service-core/email/ after the
// build, see scripts/sync-fast-servers.ts.
//
// Every literal of every rendering goes into ONE byte pool. A literal is not
// stored whole: it is assembled greedily from pool pieces that are already
// there (LZ77-style, long matches only). That way the 18 KB of CSS sits in the
// binary exactly once even though it appears in 170 documents -- and at runtime
// it is still a plain memcpy, nothing is decompressed.
import fs from 'fs'
import path from 'path'
import { TEMPLATE_ROOT, OUT_DIR, IR_PATH, ASSETS } from './manifest.mjs'

const ir = JSON.parse(fs.readFileSync(IR_PATH, 'utf8'))

const MIN_MATCH = 48 // shorter matches do not pay for their 8-byte op
const ANCHOR = 24

// latin1 == one char per byte, so string offsets are byte offsets
const toBytes = (s) => Buffer.from(s, 'utf8').toString('latin1')

class Pool {
  constructor() {
    this.s = ''
    this.idx = new Map()
    this.indexed = 0
  }
  _reindex() {
    const end = this.s.length - ANCHOR
    for (let i = this.indexed; i <= end; i++) {
      const k = this.s.substr(i, ANCHOR)
      let a = this.idx.get(k)
      if (!a) this.idx.set(k, (a = []))
      if (a.length < 4) a.push(i)
    }
    this.indexed = Math.max(this.indexed, end + 1)
  }
  _append(chunk) {
    const off = this.s.length
    this.s += chunk
    this._reindex()
    return { off, len: chunk.length }
  }
  // literal -> list of pool references
  encode(lit) {
    const ops = []
    let i = 0
    let pending = ''
    while (i < lit.length) {
      let bestLen = 0
      let bestOff = 0
      if (lit.length - i >= MIN_MATCH) {
        for (const p of this.idx.get(lit.substr(i, ANCHOR)) ?? []) {
          let l = ANCHOR
          while (i + l < lit.length && p + l < this.s.length && this.s[p + l] === lit[i + l]) l++
          if (l > bestLen) {
            bestLen = l
            bestOff = p
          }
        }
      }
      if (bestLen >= MIN_MATCH) {
        if (pending) {
          ops.push(this._append(pending))
          pending = ''
        }
        ops.push({ off: bestOff, len: bestLen })
        i += bestLen
      } else {
        pending += lit[i++]
      }
    }
    if (pending) ops.push(this._append(pending))
    return ops
  }
}

// --------------------------------------------------- collect the literals
const litIds = new Map() // literal(bytes) -> id
const lits = []
let rawTotal = 0
for (const t of ir.templates)
  for (const kind of ['html', 'subject', 'text'])
    for (const ops of t.renders[kind])
      for (const op of ops)
        if (op[0] === 'lit') {
          const b = toBytes(op[1])
          rawTotal += b.length
          if (!litIds.has(b)) {
            litIds.set(b, lits.length)
            lits.push(b)
          }
        }

// Largest literals first: that puts the shared body (CSS, header, footer) into
// the pool in one piece, and everything after it merely references that.
const pool = new Pool()
const litOps = new Array(lits.length)
for (const id of lits.map((_, i) => i).sort((a, b) => lits[b].length - lits[a].length))
  litOps[id] = pool.encode(lits[id])

// --------------------------------------------------------- build programs
// The op encoding, as src/render.c reads it -- see include/service_core/email/render.h.
const OP_SLOT = 0xffffff00
const OP_JZ = 0xfffffe00
const OP_JMP = 0xfffffd00
const OP_BRK = 0xfffffc00
const MODE = { html: 0, raw: 1, uri: 2, human: 3, humanBold: 4, humanText: 5, humanBoldText: 6 }
/* Output bytes per input byte at most, per mode -- the bounds are derived in
 * src/render.c, beside the code they bound. */
const COST = { html: 6, raw: 1, uri: 3, human: 10, humanBold: 10, humanText: 3, humanBoldText: 3 }

const OPS = [] // global op table: [off, len]

/** One IR program -> ops at the end of OPS. A jump target is an index into the program. */
function emitProgram(ops) {
  const start = OPS.length
  // A literal becomes one or more pool references, so IR indices move.
  const at = []
  let n = 0
  for (const op of ops) {
    at.push(n)
    n += op[0] === 'lit' ? litOps[litIds.get(toBytes(op[1]))].length : op[0] === 'jz' ? op[1].length : 1
  }
  at.push(n)
  let staticBytes = 0
  let cost = 0
  let slotRefs = 0
  for (const op of ops) {
    switch (op[0]) {
      case 'lit':
        for (const r of litOps[litIds.get(toBytes(op[1]))]) OPS.push([r.off, r.len])
        staticBytes += toBytes(op[1]).length
        break
      case 'slot':
        OPS.push([op[1], (OP_SLOT | MODE[op[2]]) >>> 0])
        cost += COST[op[2]]
        slotRefs++
        break
      case 'jz':
        for (const v of op[1]) {
          if (v > 0xff) throw new Error('more than 256 values in one template')
          OPS.push([at[op[2]], (OP_JZ | v) >>> 0])
        }
        break
      case 'jmp':
        OPS.push([at[op[1]], OP_JMP])
        break
      case 'brk':
        OPS.push([0, (OP_BRK | op[1]) >>> 0])
        staticBytes += op[1]
        break
    }
  }
  return { prog: [start, OPS.length - start], staticBytes, cost, slotRefs }
}

const camelToSnake = (s) =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase()
const UP = (s) => camelToSnake(s).toUpperCase()

const templates = ir.templates.map((t) => {
  const progs = []
  const max = { html: 0, subject: 0, text: 0, refs: 0, cost: 0 }
  for (let li = 0; li < ir.locales.length; li++) {
    let cost = 0
    /* The order is the one ge_emit_* indexes with: html, subject, text. */
    for (const kind of ['html', 'subject', 'text']) {
      const r = emitProgram(t.renders[kind][li])
      progs.push(r.prog)
      max[kind] = Math.max(max[kind], r.staticBytes)
      max.refs = Math.max(max.refs, r.slotRefs)
      cost += r.cost
    }
    max.cost = Math.max(max.cost, cost)
  }
  return { ...t, progs, max, progBase: null }
})

let progBase = 0
const PROGS = []
for (const t of templates) {
  t.progBase = progBase
  for (const p of t.progs) PROGS.push(p)
  progBase += t.progs.length
}

// -------------------------------------------------------------- C source
const poolBytes = Buffer.from(pool.s, 'latin1')

function cStringLiteral(buf) {
  const out = []
  let line = ''
  for (const b of buf) {
    const c = String.fromCharCode(b)
    // Three-digit octal escapes: no following digit can extend the escape.
    if (b === 0x22 || b === 0x5c || b === 0x3f) line += '\\' + c
    else if (b >= 0x20 && b < 0x7f) line += c
    else line += '\\' + b.toString(8).padStart(3, '0')
    if (line.length >= 100) {
      out.push('"' + line + '"')
      line = ''
    }
  }
  if (line) out.push('"' + line + '"')
  return out.join('\n')
}

const assetBytes = ASSETS.map(([cid, file, mime]) => ({
  cid,
  file,
  mime,
  data: fs.readFileSync(path.join(TEMPLATE_ROOT, 'includes', file)),
}))

// ---- header
const nValues = (t) => 1 + t.slots.length + t.flags.length
const MAX_SV = Math.max(...templates.map(nValues))
const maxOf = (k) => Math.max(...templates.map((t) => t.max[k]))

let h = `/* GENERATED by packages/email-native/tools/gen_c.mjs -- do not edit.
 * Source: the MJML templates in packages/email-native/templates.
 * Regenerate with \`turbo @gradido/email-native#build\`.
 */
#ifndef SERVICE_CORE_EMAIL_TEMPLATES_H
#define SERVICE_CORE_EMAIL_TEMPLATES_H

#include "service_core/email/render.h"

typedef enum {
${ir.locales.map((l, i) => `    GE_LOCALE_${l.toUpperCase()} = ${i},`).join('\n')}
    GE_LOCALE_COUNT = ${ir.locales.length}
} ge_locale_t;

typedef enum {
${templates.map((t, i) => `    GE_TPL_${UP(t.name)} = ${i},`).join('\n')}
    GE_TPL_COUNT = ${templates.length}
} ge_template_t;

`

for (const t of templates) {
  const st = `ge_${camelToSnake(t.name)}_t`
  h += `/* ${t.name} */\ntypedef struct {\n`
  for (const s of t.slots) h += `    const char *${camelToSnake(s)};\n`
  for (const f of t.flags) h += `    bool ${camelToSnake(f)};\n`
  h += `} ${st};\n\n`
  h += `int ge_render_${camelToSnake(t.name)}(ge_locale_t locale, const ${st} *v, ge_mail_t *out);\n`
  h += `int ge_render_${camelToSnake(t.name)}_into(ge_locale_t locale, const ${st} *v, ge_arena_t *a, ge_mail_t *out);\n`
  h += `int ge_render_${camelToSnake(t.name)}_into_fast(ge_locale_t locale, const ${st} *v, ge_arena_t *a, ge_mail_t *out);\n\n`
}

h += `/* Introspection: enough to dispatch generically (a JSON API, say) without
 * writing code for each template. slot_names[0] is always "locale". */
typedef struct {
    const char         *name;
    uint32_t            prog_base;
    uint32_t            n_slots;    /* including slot_names[0] == "locale" */
    const char *const  *slot_names;
    uint32_t            n_flags;
    const char *const  *flag_names;   /* NULL when the template has none */
    uint32_t            max_static_html;
    uint32_t            max_static_subject;
    uint32_t            max_static_text;
    uint32_t            max_slot_refs;
    uint32_t            max_slot_cost;  /* html + subject + text, per byte of the longest value */
} ge_template_info_t;

extern const ge_template_info_t GE_TEMPLATES[${templates.length}];

/* The largest share of a document that does not depend on the values, across all
 * templates and locales -- branches counted as if all were taken. */
#define GE_MAX_STATIC_HTML     ${maxOf('html')}u
#define GE_MAX_STATIC_SUBJECT  ${maxOf('subject')}u
#define GE_MAX_STATIC_TEXT     ${maxOf('text')}u
#define GE_MAX_SLOT_REFS       ${maxOf('refs')}u
/* What the values may add to one mail, html + subject + text, per byte of the longest
 * value: every slot use times what its mode makes of a byte at most (" -> &quot; is
 * 6, a link in a person's text 10). */
#define GE_MAX_SLOT_COST       ${maxOf('cost')}u
/* The most values one template takes, "locale" and the flags included. */
#define GE_MAX_VALUES          ${MAX_SV}u

/* Upper bound for one mail, all three parts, if no value is longer than max_field. */
#define GE_BUF_SIZE(max_field) \\
    (GE_MAX_STATIC_HTML + GE_MAX_STATIC_SUBJECT + GE_MAX_STATIC_TEXT + 3u + \\
     GE_MAX_SLOT_COST * (size_t)(max_field))

/* The generic counterpart to the typed wrappers, addressed by index rather than by
 * struct field -- what a dispatcher works with, an HTTP handler or a Node-API addon
 * that only ever sees a name and an object. slots[0] is ignored: the renderer fills
 * the locale. flags may be NULL when the template has none. */
int ge_render_values(ge_template_t t, ge_locale_t locale, const char *const *slots,
                     const bool *flags, ge_mail_t *out);
int ge_render_values_into(ge_template_t t, ge_locale_t locale, const char *const *slots,
                          const bool *flags, ge_arena_t *a, ge_mail_t *out);
int ge_render_values_into_fast(ge_template_t t, ge_locale_t locale, const char *const *slots,
                               const bool *flags, ge_arena_t *a, ge_mail_t *out);

/* Lookup by name, for the server's HTTP dispatch */
int          ge_template_by_name(const char *name);   /* -1 if unknown */
int          ge_locale_by_code(const char *code);     /* -1 if unknown */
const char  *ge_template_name(ge_template_t t);
const char  *ge_locale_code(ge_locale_t l);

/* Inline attachments (cid:) -- these live in the binary too */
extern const ge_asset_t GE_ASSETS[${assetBytes.length}];
#define GE_ASSET_COUNT ${assetBytes.length}

#endif
`

// ---- implementation
let c = `/* GENERATED by packages/email-native/tools/gen_c.mjs -- do not edit.
 * Regenerate with \`turbo @gradido/email-native#build\`.
 */
#include "service_core/email/templates.h"
#include <stddef.h>
#include <string.h>

static const char GE_POOL[] =
${cStringLiteral(poolBytes)};

static const ge_op_t GE_OPS[] = {
${OPS.map(([o, l]) => `{${o},${l >>> 0}u}`).join(',').replace(/(.{110}[^,]*,)/g, '$1\n')}
};

static const ge_prog_t GE_PROGS[] = {
${PROGS.map(([s, n]) => `{${s},${n}}`).join(',').replace(/(.{110}[^,]*,)/g, '$1\n')}
};

static const char *const GE_LOCALE_CODES[] = {${ir.locales.map((l) => `"${l}"`).join(',')}};
static const char *const GE_TEMPLATE_NAMES[] = {${templates.map((t) => `"${t.name}"`).join(',')}};

const char *ge_locale_code(ge_locale_t l)     { return GE_LOCALE_CODES[l]; }
const char *ge_template_name(ge_template_t t) { return GE_TEMPLATE_NAMES[t]; }

int ge_template_by_name(const char *name) {
    for (int i = 0; i < GE_TPL_COUNT; i++)
        if (strcmp(GE_TEMPLATE_NAMES[i], name) == 0) return i;
    return -1;
}
int ge_locale_by_code(const char *code) {
    for (int i = 0; i < GE_LOCALE_COUNT; i++)
        if (strcmp(GE_LOCALE_CODES[i], code) == 0) return i;
    return -1;
}

/* A flag is a value too, as far as a program is concerned: set or not. */
static const char GE_FLAG_ON[] = "1";

/* prog = GE_PROGS[base + locale * 3 + kind], kind 0=html 1=subject 2=text */
static int ge_emit(uint32_t base, ge_locale_t locale, const char *const *sv, ge_mail_t *out) {
    if ((unsigned)locale >= GE_LOCALE_COUNT) return -1;
    const ge_prog_t *p = &GE_PROGS[base + (uint32_t)locale * 3u];
    if (ge_run(GE_POOL, &GE_OPS[p[0].start], p[0].count, sv, &out->html) != 0) return -1;
    if (ge_run(GE_POOL, &GE_OPS[p[1].start], p[1].count, sv, &out->subject) != 0) {
        ge_str_free(&out->html);
        return -1;
    }
    if (ge_run(GE_POOL, &GE_OPS[p[2].start], p[2].count, sv, &out->text) != 0) {
        ge_str_free(&out->html);
        ge_str_free(&out->subject);
        return -1;
    }
    return 0;
}

/* Same into an arena: no malloc, no free. The three parts sit back to back. */
static int ge_emit_into(uint32_t base, ge_locale_t locale, const char *const *sv, ge_arena_t *a,
                        ge_mail_t *out) {
    if ((unsigned)locale >= GE_LOCALE_COUNT) return -1;
    const ge_prog_t *p = &GE_PROGS[base + (uint32_t)locale * 3u];
    /* On -1, out->html.len carries the total requirement for ge_arena_ensure(). */
    if (ge_run_into(GE_POOL, &GE_OPS[p[0].start], p[0].count, sv, a, &out->html) != 0) return -1;
    if (ge_run_into(GE_POOL, &GE_OPS[p[1].start], p[1].count, sv, a, &out->subject) != 0) {
        out->html.data = NULL;
        out->html.len  = a->used + out->subject.len;
        return -1;
    }
    if (ge_run_into(GE_POOL, &GE_OPS[p[2].start], p[2].count, sv, a, &out->text) != 0) {
        out->html.data = NULL;
        out->html.len  = a->used + out->text.len;
        return -1;
    }
    return 0;
}

static int ge_emit_into_fast(uint32_t base, ge_locale_t locale, const char *const *sv,
                             ge_arena_t *a, ge_mail_t *out) {
    const ge_prog_t *p = &GE_PROGS[base + (uint32_t)locale * 3u];
    ge_run_into_fast(GE_POOL, &GE_OPS[p[0].start], p[0].count, sv, a, &out->html);
    ge_run_into_fast(GE_POOL, &GE_OPS[p[1].start], p[1].count, sv, a, &out->subject);
    ge_run_into_fast(GE_POOL, &GE_OPS[p[2].start], p[2].count, sv, a, &out->text);
    return 0;
}

`

for (const t of templates) {
  const fn = camelToSnake(t.name)
  const st = `ge_${fn}_t`
  // The value vector a program reads: locale, the slots, then the flags as set/unset.
  c += `static void ge_prep_${fn}(ge_locale_t locale, const ${st} *v, const char **sv) {\n`
  c += `    sv[0] = ge_locale_code(locale);\n`
  t.slots.forEach((s, i) => (c += `    sv[${i + 1}] = v->${camelToSnake(s)};\n`))
  t.flags.forEach((f, i) => (c += `    sv[${t.slots.length + 1 + i}] = v->${camelToSnake(f)} ? GE_FLAG_ON : NULL;\n`))
  c += `}\n\n`
  const call = `    const char *sv[${nValues(t)}];\n    ge_prep_${fn}(locale, v, sv);\n`
  c += `int ge_render_${fn}(ge_locale_t locale, const ${st} *v, ge_mail_t *out) {\n${call}` +
    `    return ge_emit(${t.progBase}u, locale, sv, out);\n}\n\n`
  c += `int ge_render_${fn}_into(ge_locale_t locale, const ${st} *v, ge_arena_t *a, ge_mail_t *out) {\n${call}` +
    `    return ge_emit_into(${t.progBase}u, locale, sv, a, out);\n}\n\n`
  c += `int ge_render_${fn}_into_fast(ge_locale_t locale, const ${st} *v, ge_arena_t *a, ge_mail_t *out) {\n${call}` +
    `    return ge_emit_into_fast(${t.progBase}u, locale, sv, a, out);\n}\n\n`
}

c += `
${templates.map((t) => `static const char *const GE_SLOTS_${UP(t.name)}[] = {${['locale', ...t.slots].map((s) => `"${s}"`).join(',')}};`).join('\n')}
${templates.filter((t) => t.flags.length).map((t) => `static const char *const GE_FLAGS_${UP(t.name)}[] = {${t.flags.map((f) => `"${f}"`).join(',')}};`).join('\n')}

const ge_template_info_t GE_TEMPLATES[${templates.length}] = {
${templates.map((t) => `    { "${t.name}", ${t.progBase}u, ${t.slots.length + 1}u, GE_SLOTS_${UP(t.name)}, ${t.flags.length}u, ${t.flags.length ? `GE_FLAGS_${UP(t.name)}` : 'NULL'}, ${t.max.html}u, ${t.max.subject}u, ${t.max.text}u, ${t.max.refs}u, ${t.max.cost}u }`).join(',\n')}
};

static int ge_values(ge_template_t t, ge_locale_t locale, const char *const *slots,
                     const bool *flags, const char **sv) {
    if ((unsigned)t >= GE_TPL_COUNT) return -1;
    const ge_template_info_t *ti = &GE_TEMPLATES[t];
    sv[0] = ge_locale_code(locale);
    for (uint32_t i = 1; i < ti->n_slots; i++) sv[i] = slots[i];
    for (uint32_t i = 0; i < ti->n_flags; i++) sv[ti->n_slots + i] = flags[i] ? GE_FLAG_ON : NULL;
    return 0;
}

int ge_render_values(ge_template_t t, ge_locale_t locale, const char *const *slots,
                     const bool *flags, ge_mail_t *out) {
    const char *sv[${MAX_SV}];
    if (ge_values(t, locale, slots, flags, sv) != 0) return -1;
    return ge_emit(GE_TEMPLATES[t].prog_base, locale, sv, out);
}

int ge_render_values_into(ge_template_t t, ge_locale_t locale, const char *const *slots,
                          const bool *flags, ge_arena_t *a, ge_mail_t *out) {
    const char *sv[${MAX_SV}];
    if (ge_values(t, locale, slots, flags, sv) != 0) return -1;
    return ge_emit_into(GE_TEMPLATES[t].prog_base, locale, sv, a, out);
}

int ge_render_values_into_fast(ge_template_t t, ge_locale_t locale, const char *const *slots,
                               const bool *flags, ge_arena_t *a, ge_mail_t *out) {
    const char *sv[${MAX_SV}];
    ge_values(t, locale, slots, flags, sv);
    return ge_emit_into_fast(GE_TEMPLATES[t].prog_base, locale, sv, a, out);
}

`

for (const a of assetBytes)
  c += `static const unsigned char GE_ASSET_${UP(a.cid)}[] = {${[...a.data].join(',')}};\n`

c += `
const ge_asset_t GE_ASSETS[${assetBytes.length}] = {
${assetBytes
  .map((a) => `    { "${a.cid}", "${a.file}", "${a.mime}", GE_ASSET_${UP(a.cid)}, sizeof GE_ASSET_${UP(a.cid)} }`)
  .join(',\n')}
};
`

fs.mkdirSync(path.join(OUT_DIR, 'service_core', 'email'), { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, 'service_core', 'email', 'templates.h'), h)
fs.writeFileSync(path.join(OUT_DIR, 'templates.c'), c)

/* The value sets the snapshots are rendered with (tools/values.mjs), for tools/dump.c and
 * nothing else: per set the indices into the value vector that are left unset. Test data,
 * so a file of its own that the addon and fast-servers never compile. */
let ts = `/* GENERATED by packages/email-native/tools/gen_c.mjs -- do not edit. Test data. */
#include "service_core/email/templates.h"

`
for (const t of templates) {
  const values = ['locale', ...t.slots, ...t.flags]
  const flat = t.valueSets.flatMap((set) => [set.length, ...set.map((n) => values.indexOf(n))])
  ts += `static const unsigned short GE_TEST_${UP(t.name)}[] = {${flat.join(',')}};\n`
}
ts += `
/* { number of sets, then per set: how many values are unset, and which } */
const struct { unsigned n_sets; const unsigned short *cleared; } GE_TEST_SETS[${templates.length}] = {
${templates.map((t) => `    { ${t.valueSets.length}u, GE_TEST_${UP(t.name)} }`).join(',\n')}
};
`
fs.writeFileSync(path.join(OUT_DIR, 'test_sets.c'), ts)

const kb = (n) => (n / 1024).toFixed(1) + ' KB'
const assetTotal = assetBytes.reduce((s, a) => s + a.data.length, 0)
console.error(`literals, raw       ${kb(rawTotal)}  (${lits.length} distinct)`)
console.error(`byte pool           ${kb(poolBytes.length)}  -> factor ${(rawTotal / poolBytes.length).toFixed(1)}x`)
console.error(`ops                 ${OPS.length} x 8 B = ${kb(OPS.length * 8)}`)
console.error(`programs            ${PROGS.length} (${templates.length} templates x ${ir.locales.length} locales x {html,subject,text})`)
console.error(`max static share    html ${maxOf('html')} B, subject ${maxOf('subject')} B, text ${maxOf('text')} B, up to ${maxOf('refs')} slot uses, cost ${maxOf('cost')} B per value byte`)
console.error(`assets (PNG)        ${kb(assetTotal)}`)
console.error(`expected data size  ~${kb(poolBytes.length + OPS.length * 8 + PROGS.length * 8 + assetTotal)}`)
