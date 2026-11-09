# @gradido/email-native

The e-mail templates as C, with no templates in the deploy.

The MJML templates under `templates/` are the single source of truth, with the message
catalogues in `po/`. MJML runs once per template at build time; per locale the messages go
in by string replacement, and the result becomes a byte pool and three small programs per
locale — html, subject, text — that copy pool slices, write values, and jump over the
branches the values do not select. That is what ships: in this package as a Node-API
addon, and in `fast-servers` as two C files linked straight into the binary. At runtime
there is no template directory, no parser and no i18n library — `memcpy`, escaping and a
handful of jumps.

```text
templates/*.mjml ─┐
templates/includes/ ─┤ tools/extract_mjml.mjs  (mjml + gettext, build time only)
po/<lang>/messages.po ┘
                 ▼
              ir.json                            the programs, in the op format of
                 │ tools/gen_c.mjs               tools/runtime.mjs
                 ▼
   email/templates.{h,c} ──┬─► email_native.node   (this package)
                           └─► fast-servers/service-core/email/  (copied by the build)
```

## The markers, and what they become

A template is English prose with holes in it:

```xml
<mj-text mj-class="muted">{{t:Hello %1 %2,|firstName,lastName}}</mj-text>
<mj-button href="{{v:communityURL}}/contacts?with={{u:senderUuid}}">{{t:Reply}}</mj-button>
<mj-text css-class="human-text">{{t:Message: %1|h:transactionMemo}}</mj-text>
{{if senderCommunityUuid && senderUuid}} … {{elif forwarded}} … {{else}} … {{end}}
```

`{{t:…}}` is a gettext message — the English text IS the key, the way `packages/frontend`
writes `t.__('Sign in')`, so a template reads like a mail with no tooling in the way and a
missing translation degrades to English. A value is written in one of four modes:

```text
{{v:name}}    HTML-escaped (& < > ")                       raw in the subject and the text part
{{u:name}}    one URI component, as encodeURIComponent
{{h:name}}    text a person typed: escaped, web and mail addresses as links
{{hb:name}}   the same, and **bold** -- a chat message, a moderator's message
```

`h` and `hb` are legacy's `+humanText` (`core/src/logic/HumanText.logic.ts`), and their rules
are the wallet's: a link only for http, https and ftp, the link text always the address
itself, a video invitation of Gradido's own form shown as its room. `src/render.c` does it at
runtime by hand, `tools/runtime.mjs` with legacy's own regular expressions, and
`tests/human_text.test.mjs` holds the two together over legacy's cases and 3000 random texts.

A message argument takes the same prefixes, and a wrapper for the HTML part where the message
decides where the value stands: `{{t:Your thank-you to %1|recipientAlias/whole}}`.

A branch marker alone on its line may stand between any two elements; MJML is handed it as
`<mj-raw>`, which it places between them with its Outlook wrappers closed on both sides.
Inside an mj-text a marker is written inline. A name that appears only in conditions is a
flag, a `bool` in the C struct. `tools/markers.mjs` is the whole grammar, and
`tests/markers.test.mjs` runs every shape of it.

## The pug importer

`templates/<name>/*.pug` and `locales/*.json` are legacy's form of the same mails, and they
are **not** part of the build. They are kept, refreshed from `../gradido`, so that a change
arriving there can be brought over:

```sh
bun run po            # new catalogue keys -> po/, existing translations kept
# edit templates/<name>.mjml by hand
bun run import:pug    # both extractors, then compare them on CONTENT
```

`tools/extract.mjs` renders legacy's pug with the value sets of the MJML translation (see
*The snapshots*), and `tools/compare_pug.mjs` holds the two against each other where it
matters — subject byte for byte, plain text byte for byte, HTML as *visible text* — because
comparing div-and-class against nested tables byte for byte would say "everything differs"
and mean nothing. A value legacy uses and the translation does not is reported too. It is
the reason converting a mail by hand is safe.

## What the build does

```sh
bun install
turbo @gradido/email-native#build     # or: bun run build, from this directory
```

`build` is `c-cpp-zig-build` followed by `scripts/sync-fast-servers.ts`. It runs the
snapshot check on the way (see below) and produces three things:

```text
build/email_native.node                          the addon: renderer + SMTP sending
build/gen/service_core/email/templates.h         the generated renderer
build/gen/templates.c
fast-servers/service-core/{include,src}/email/   the same two, plus render.h and render.c
```

The copy into `fast-servers` is why that build needs neither node nor mjml: it compiles the
generated C rather than generating it. The four files it receives are checked in, so
`zig build` in `fast-servers` works in a fresh checkout — and they are **outputs**, not
sources. Change a template, run the build, commit what it wrote; never edit the copies in
`fast-servers`.

`build.zig` registers every file under `templates/` and `po/` as a build input, so the
codegen re-runs exactly when a template or a translation changes. Zig hashes contents rather than mtimes, so
a bare `touch` triggers nothing, and an unchanged file is not rewritten in `fast-servers`
either — a rebuild that changed nothing leaves no `git status` behind.

Turbo caches `build`. If the files in `fast-servers` were removed by hand, the cache hit
will not put them back: `turbo @gradido/email-native#build --force` re-runs the copy.

## The snapshots

`tests/__snapshots__/` holds every document **as tools/runtime.mjs renders it** — per
template, locale and value set, {html, subject, text} — with test values containing
everything that can go wrong (`& < > " '`, non-ASCII, links, a shortened video link, a mail
address, bold) and checked into git, one file per document:

```text
tests/__snapshots__/accountActivation/de.0.html
tests/__snapshots__/accountActivation/de.0.subject
tests/__snapshots__/accountActivation/de.0.text
```

A **value set** is what a document is rendered with. Not every combination of a template's
branches: set 0 has everything set, and each further set leaves unset what it takes to reach
one other case of one branch — so every jump is taken and not taken at least once, and
customEmail has 8 sets where it would have 96 combinations. The sets travel in `ir.json`, and
`tools/gen_c.mjs` writes them into `test_sets.c`, which only `tools/dump.c` links.

The templates stay the source of truth. The snapshots are how a change to them becomes
**visible**: an MJML upgrade, an edited template or a corrected translation shows up as a
diff over exactly the documents it reached, and over nothing else. Four things compare
against them, and none of them compares an implementation against itself:

```text
tests/snapshots.test.mjs   the extractor renders today what the snapshots say
tests/preview.test.mjs     the preview page renders what the snapshots say
tests/addon.test.js        the addon renders what the snapshots say
zig build check            the C binary renders what the snapshots say
```

The last one is `tools/verify.mjs` over what `tools/dump.c` wrote, and it needs no mjml at
all — the first line is what keeps the reference honest. Together they are what backs "the C
sends the same mail as the templates say".

`check` is not a task of its own: it hangs off the default build step, so `npx czb` and
`turbo @gradido/email-native#build` run it. A build whose tables no longer match the
templates fails there rather than in a mail — and, more to the point, before
`scripts/sync-fast-servers.ts` copies anything into `fast-servers`.

**When a template, a catalogue or the MJML version changes:**

```sh
bun run snapshots:update              # tools/snapshots.mjs, the only writer
git diff tests/__snapshots__          # read it -- this is the review
turbo @gradido/email-native#build     # regenerate the C, check it, copy it to fast-servers
```

An update that touches documents you did not expect is the finding, not the noise.

```sh
turbo @gradido/email-native#test      # the build ran the C check; these are the JS halves
bun run bench                         # sending and rendering, against nodemailer
```

Bun's own snapshot mechanic (`toMatchSnapshot`, one `.snap` per test file) is not used here,
and that is a deliberate trade: three consumers have to read these files, and one of them is
a `zig build` step with neither bun nor mjml in reach. Plain files are readable by all three,
diff per document rather than as one blob, and let `tools/dump.c` write straight into a
comparable shape.

## How the branches are handled

A branch is a jump. `{{if a}} A {{elif b}} B {{else}} C {{end}}` becomes

```text
jz a -> L1     A     jmp -> END
L1: jz b -> L2 B     jmp -> END
L2: C
END:
```

and `a && b` is two `jz` to the same place. The template is the only place a branch is
written: there is no table beside it that could disagree, and the struct fields are the
names the markers use, so renaming one fails the next build at the call site with a compiler
error rather than leaving a blank spot in the mail.

Every case of every branch ships, in every locale, inside the one program. That is what
keeps the size flat: the earlier form rendered every combination out at build time, and the
chat mail alone, with six independent branches, would have been 96 programs per locale and
part. As jumps it is three.

In the text part, the line breaks html-to-text puts around a block stand next to the block's
markers and have to go with it when it is skipped. They become a `brk` op there: n line
breaks before the next output, merged by max the way html-to-text merges block breaks, and
dropped at the start and at the end.

## Why it is 370 KB of data and not 4.8 MB

21 templates × 10 locales × ~25 KB is 4.8 MB of literals, dominated by the markup MJML
repeats in every document. `tools/gen_c.mjs` does not store one literal block per document:
it assembles each literal greedily out of pool pieces that are already there (LZ77-style,
matches ≥ 48 bytes only). Header, footer and the shared tables land in the pool exactly once.

| | jumps, 21 templates | rendered out, 17 templates | pug, before |
|---|---|---|---|
| literals, raw | 4802.8 KB | 6125.3 KB | 5645.2 KB |
| byte pool | **146.3 KB** (factor 32.8×) | 149.1 KB | 129.0 KB |
| ops | 26893 × 8 B = 210.1 KB | 36342 × 8 B = 283.9 KB | 115.5 KB |
| inline PNGs (`cid:`) | 28.4 KB | 28.4 KB | 28.4 KB |
| **data in the binary** | **~390 KB**, 630 programs | ~468 KB, 810 programs | ~279 KB |

Four more mails and twice the branches cost less than the seventeen did rendered out. At
runtime it is still a plain `memcpy` — nothing is decompressed.

### And compressing it would cost more than it saves

Measured on this data rather than assumed, because it is the obvious next idea. Pool, ops
and programs together are 370 KB; the PNGs are compressed already (21.4 → 21.0 KB with
zlib).

```text
                     packed     decoder, static,       saved in the binary
                                stripped, gc-sections
zstd -19             62.6 KB    40 KB decompress-only  ~267 KB
                                103 KB default build   ~204 KB
zlib -9              78.9 KB    33 KB (addon)          ~258 KB
                                 0 KB (fast-servers:   ~291 KB
                                 h2o links it already)
```

So it would save about a quarter megabyte of file, and unpacking takes 0.3 ms (zstd) or
0.7 ms (zlib) once at startup. Its rendering speed afterwards is the same: the layout in
memory is the same layout.

What it costs is memory, and the wrong kind. `.rodata` is file-backed and demand-paged, and
a deployment touches only what it renders — measured over the op table and the pool, in
4 KiB pages:

```text
resident as .rodata     one mail type, de                       116 KB
                        the five commonest, de                  152 KB
                        all 21, de                              252 KB
                        all 21, de + en                         280 KB
                        everything                              360 KB
resident unpacked       always                                  361 KB
```

Those `.rodata` pages are clean: shared by every process that maps the binary, dropped by
the kernel under pressure, read back on demand. An unpacked copy is anonymous private memory
— 361 KB in every process, the whole of it, none of it shared and none of it droppable
without swap — and `GE_OPS` would lose its `const` on the way. Compression trades disk for
RAM here, in the wrong direction. If binary size ever becomes the constraint, drop locales
at build time or compress the deployment artifact; both reach the same bytes without paying
for them at runtime.

## Buffer sizes

The static share is a build-time constant, because it is template bytes only — counted as if
every branch were taken:

```text
GE_MAX_STATIC_HTML     25550 B
GE_MAX_STATIC_SUBJECT    119 B
GE_MAX_STATIC_TEXT      2083 B
GE_MAX_SLOT_REFS          17          slot uses per document
GE_MAX_SLOT_COST         127          output bytes per byte of the longest value, all three parts
```

What the values add is counted per **use** and per **mode**: `"` → `&quot;` is six output
bytes per input byte, a link in a person's text at most ten (the address twice, escaped, in
its tag), a URI component three. `GE_MAX_SLOT_COST` is the sum over the uses of one mail, and
`GE_BUF_SIZE(n) = statics + 3 + GE_MAX_SLOT_COST × n` the bound for values up to n bytes.

**96 KB per thread.** `GE_BUF_SIZE(512)` is 90.6 KB, and that is a bound for any input, not
a measurement; with every value 512 bytes of `"`, the largest mail actually needs 74.8 KB
(`transactionReceived/ru`). The addon reserves `GE_BUF_SIZE(512)`.

The arena is checked, not assumed, so an undersized one costs a second render rather than a
corrupt mail — but sizing it below the bound means paying that on the documents that need it
most:

```c
ge_arena_t arena;
ge_arena_init(&arena, 96u << 10);        /* once at startup */

for (;;) {
    ge_mail_t m;
    ge_arena_reset(&arena);              /* per mail: used = 0, nothing else */
    if (ge_render_thank_you_card_paid_into(loc, &v, &arena, &m) != 0) {
        ge_arena_ensure(&arena, m.html.len);  /* m.html.len = the total requirement */
        ge_render_thank_you_card_paid_into(loc, &v, &arena, &m);
    }
    ...
}
```

## Sending: one connection per mail, on the host's thread pool

The addon does **not** use `sc_mailer`, service-core's pooled mailer. It compiles the two
layers underneath it — straight out of the fast-servers checkout rather than vendored, so the
two paths cannot send different mail:

```text
service-core/src/email/message.c     the RFC 5322 bytes: headers, RFC 2047 subject, CRLF
service-core/src/email/transport.c   one curl session: connect, authenticate, hand over
-----------------------------------------------------------------------------------------
service-core/src/email/mailer.c      the queue, the retry and the worker pool -- not here
```

Every `send()` is a `napi_create_async_work`: `execute()` opens a session on a libuv thread
pool thread, hands over one message and closes it; `complete()` settles a `Promise` on the JS
thread with the Message-ID, or rejects it with the relay's own words. That is the same shape
nodemailer has by default, and it is the reason **this addon links no libuv and no arnm at
all** — the two files above have neither threads nor an arena.

`verify()` is that same work with the message left out: the greeting, `EHLO`, the configured
TLS upgrade and `AUTH`, then `NOOP` and goodbye. It resolves when the relay took the session
and rejects with the relay's own words when it did not, and it touches neither `sent` nor
`failed` — nothing was mailed. It is what a starting server asks so that a wrong port or a
rotated password is a line in its log rather than a mail that quietly never arrives, and the
reason it belongs here rather than in the caller is that it is **the same libcurl and the same
trust configuration the sends use**: a certificate Node's `tls` would accept and mbedtls would
not must fail this check, not the first mail after it. `packages/backend` calls it once at
startup, and `sc_mail_session_probe` is the same thing on the C path.

Two costs come with it, and both are the trade rather than an oversight:

- **A connection per mail is a TCP handshake, a TLS handshake and the SMTP greeting dialogue.**
  On loopback that is 225 µs against 85 µs on a kept session; against a remote relay it is
  round trips, so hundreds of milliseconds.
- **The pool has four threads** (`UV_THREADPOOL_SIZE`), shared with `fs`, `dns` and `crypto`,
  and a send holds its thread for the whole session. So the wrapper takes at most
  `UV_THREADPOOL_SIZE - 1` of them and queues the rest: filling every thread with mail would
  stall every file read in the process for as long as the relay takes. `maxConcurrent`
  overrides it, `stats.limit` says what it resolved to, and `stats.waiting` how many sends are
  holding back.

  The gate is in `index.cjs` rather than in C, and that is a memory decision: a send waiting
  there holds a recipient and a few values, one queued on the C side would already hold its
  formatted message — ~64 KB with the images. A thousand queued mails is the difference between
  a rounding error and 64 MB.

For registration and notification mail — one mail per request, and the caller wants to know
whether it went — that is the right trade. Bulk mail is what `fast-servers` and its pool are
for. `-Dmailer=false` leaves the sending half out entirely.

`curl` is built against **mbedTLS**, and that is what makes an addon viable at all: it lives
inside a process that already has a TLS library — OpenSSL in Node, BoringSSL in Bun — and a
second one exporting the same `SSL_*`/`EVP_*` symbols would leave link order to decide which
of them verifies a certificate. mbedTLS has its own API and its own symbol prefix. Verified
rather than assumed:

```sh
nm -D --defined-only build/email_native.node | grep -cE ' (SSL_|EVP_|OPENSSL_|CRYPTO_|X509_)'
0
```

`tests/tls.test.js` stands up an `smtps://` relay with a self-signed certificate and has the
addon deliver through it, then points the mailer at a certificate the relay was not signed
by and asserts that nothing is delivered. A build that only compiles would prove nothing.


### One exported symbol, and why it matters

`napi/exports.map` exports `napi_register_module_v1` and localises everything else. A
*global* symbol is preemptible, so a name the addon exports and the host also defines is
resolved by link order rather than by which library the call came from. That bit hard once:
while the addon still linked its own libuv, its `uv_cond_init()` bound to Bun's shim, which
aborts the process — it looked like "Bun cannot run threads in an addon" and was nothing of
the sort. libuv is gone now, but mbedTLS and curl are still in here, so the version script
stays: one exported symbol, and ~148 KB of `.dynsym`/`.dynstr`/`.hash` saved with it.

## The preview

```sh
bun run preview        # http://localhost:4321
```

Every locale of a template in a browser, with the values editable and the flags as switches —
empty a value or untick a flag and the branches on it go, as they would in a mail. A
40-character surname is the useful experiment. The page carries `tools/runtime.mjs`
verbatim and runs the same programs C runs, so switching a locale costs no round trip and
what you look at is what the C would send. `tests/preview.test.mjs` checks that the page is
built with that source and runs it against every snapshot.

`fs.watch` over `templates/`, `po/` and `.preview-values.json` re-runs the extractor and
pushes a reload down an SSE stream. A broken template leaves the last good build standing
and writes the error to the terminal rather than going dark.

For the editor's own split-screen preview, `.mjmlconfig.js` fills the markers with real
text and picks the branches the sample values select: `.preview-locale` (gitignored) picks
your language, `.preview-values.json` the values. VS Code needs `"mjml.allowIncludes": true`
— without it `mj-include` is skipped silently and the preview loses header and footer.

## Speed: the N-API boundary costs more than the render

`accountActivation/de`, 100k renders, one core, ns per mail (`tests/render-bench.mjs`):

| | Node 24 | Bun 1.4 |
|---|---|---|
| the same programs run in JS (`tools/runtime.mjs`) | **1688** | **2138** |
| pug — legacy's renderer, for reference | 3455 | 7964 |
| addon `render()` — three JS strings | 27287 | 63337 |
| addon `renderBytes()` — three Buffers | 10399 | 6640 |
| `send()`, the synchronous half — render + MIME, no JS value | 76819 | 116326 |

The C render itself is under 0.9 µs (`zig build bench`); everything above it is the
boundary. **Running the programs in JavaScript is faster than the addon whenever the document
has to become a JS value**, which is the finding that matters most here, and the reason this
package exists for `fast-servers` first and for the TypeScript path only where a mail never
becomes a JS value.

The first row is not a hypothetical: `build/tools/mjml/ir.json` is on disk anyway and the
runtime is the same file the preview runs. `tests/render-bench.mjs` checks it against the
addon's output first, so the two are timed on bytes already proven equal. The pug row is
legacy's renderer over legacy's markup; it renders a different, smaller document and is here
so the comparison to the system being replaced does not disappear.

The last row is not the boundary, it is the encodings: quoted-printable over 25 KB of HTML and
base64 over 28 KB of inline images, which is what turns a 25 KB document into a ~70 KB message.
It caps one JS thread at roughly ten thousand mails a second — far above what one connection
per mail delivers, so it is a number to know rather than one to optimise.

> Measuring that last row needs `maxConcurrent` opened up. `index.cjs` gates sends at
> `UV_THREADPOOL_SIZE - 1`, so with the default only the first three do their synchronous work
> before returning and the rest park on a promise — the mean then measures the gate, 3.4 µs,
> and not render + MIME.

`zigNative.optimize` is `fast`, not the `small` that `c-cpp-zig-build` defaults to: for a
memcpy-bound renderer `small` costs ~35 % (`render()` 21.3 µs vs. 13.8 µs).

Sending, `bun run bench`: 1000 mails, 23129 B body, 4 in flight, relay in its own process,
Node 18 on one machine — µs per mail:

| | plain | smtps |
|---|---|---|
| addon, one connection per mail | **246** | **1578** |
| nodemailer, pooled, as configured | 11621 | 11721 |
| nodemailer, pooled, `TCP_NODELAY` forced | 1302 | 1353 |

The body is 23129 B where it was 20897 B under pug — the tables again. It moves the sending
numbers by a few percent and nothing about their shape.

**Nagle** is nodemailer's second row: curl sets `TCP_NODELAY`, Node does not, so each message
eats a delayed-ACK stall. Forcing it is worth 8x, and Bun sets it already — so that row is the
one to compare against.

**What the connection per mail costs.** Plain SMTP against a held connection is 85 µs and
against a new one 225 µs (`email/transport.h`, measured in the h2o prototype) — and 246 µs is
close to where this lands, so on plain SMTP the price of not pooling is that ~2.5x. Over TLS it
is 246 → 1578 µs, and the extra 1330 µs is a handshake per mail: asymmetric crypto on *both*
sides plus its round trips. That is the number the design decision cost, and against a remote
relay it would be larger still, because then the round trips are milliseconds rather than
microseconds.

**Threads are not where it comes from.** The sends scale with what is in flight and then stop:

```text
1 in flight   2046 mails/s        UV_THREADPOOL_SIZE=8,  8 in flight   3507 mails/s
2             2799                UV_THREADPOOL_SIZE=16, 16           3589
4             3403
8             3363
```

The ceiling is the single-process JS relay, not the pool — raising `UV_THREADPOOL_SIZE` moves
nothing. A pool of dedicated threads would hit the same wall here, which is why the addon
giving up its own threads costs nothing measurable and the handshake costs everything.

For comparison, service-core's pooled `sc_mailer` measured **102 µs plain and 194 µs over
smtps** in the prototype this package came from. Those are from another machine and another
run, and nothing here reproduces them — the addon no longer contains that path. What would
settle it is a throughput benchmark beside `fast-servers/benchmarks/`, which is where the
pooled mailer lives now.

## The message on the wire

What leaves the process, and both paths put out the same bytes —
`service-core/src/email/message.c` writes them for the addon and for `fast-servers`:

```text
multipart/alternative
  text/plain; charset=utf-8                  quoted-printable
  multipart/related; type="text/html"        the templates' six cid: images ride along
    text/html; charset=utf-8                 quoted-printable
    image/png x6                             base64, Content-ID: <...>, inline
```

The text part comes off the same document: `tools/extract.mjs` runs `html-to-text` over the
**sentinel** HTML at build time, so the slots survive into a third program and C fills them at
runtime — see `TEXT_OPTIONS` in `tools/manifest.mjs` for the four decisions that took. Text
first and HTML second, because RFC 2046 5.1.4 puts the alternatives in increasing order of
faithfulness. `sendMail()` takes `text`, `html` or both and builds the same shapes.

| | |
|---|---|
| `Date:` | RFC 5322 3.3, UTC, names spelled out — a `de_DE` process would write "Mo, 25 Aug" |
| `Message-ID:` | RFC 5322 3.6.4, and it survives the retry, so one mail is one id |
| `Subject:` | RFC 2047 base64 encoded-words when not ASCII, folded, split on character boundaries |
| `From:` | display name quoted when it carries a special, RFC 2047 encoded when not ASCII |
| addresses | a control character is refused — in the recipient and in the sender |
| bodies | quoted-printable: 7-bit, and no line past 76 characters |
| text part | derived from the HTML at build time, values filled as text (`GE_MODE_RAW`, `GE_MODE_HUMAN_TEXT`) |
| images | base64, `Content-ID` matching the `cid:` the HTML names, `Content-Disposition: inline` |
| line endings | CRLF throughout, dot stuffing left to curl (RFC 5321 4.5.2) |

Verified rather than asserted. `tests/addon.test.js` sends one through a relay and checks the
wire: the structure, the order of the alternatives, one `Content-ID` per asset, no byte above
126, no line past 998, and the quoted-printable decoded back **byte for byte equal to what
`render()` produced** — an encoding that loses a byte would pass every other check.
`service-core/tests/test_mail.cpp` covers the same from the C side, part by part.

The text part is held to the templates the same way the HTML is: `zig build check` renders
every document from the C binary and compares it against the snapshots, and those are what
`html-to-text` produced from the MJML output. The two sides do it in opposite orders — the build
converts the sentinel HTML and lets C fill the slots, the check fills the slots and converts
afterwards — so they agree only because `wordwrap` is off. A value with a line break in it
would diverge, and the fixture values deliberately have none.

Two things this cost, and both are the trade rather than a surprise:

- **A mail is ~70 KB where the document alone is 25 KB.** The six images are 28 KB and base64
  adds a third. That is what an HTML mail with inline images weighs; the alternative is
  hosting them, which the templates do not do.
- **`SC_MAIL_MESSAGE_DEFAULT` went from 32 to 96 KiB**, and the pooled mailer reserves
  `queue_max` of those — ~24 MB rather than ~8 MB for the default queue of 256. A deployment
  that sends fewer at once should say so with `queue_max`.

### What is still missing

- **SMTPUTF8** (RFC 6531) is not negotiated, so an internationalised address is passed through
  rather than rejected. Every address this project has is ASCII; when one is not, that is a
  feature to add and not a byte to refuse.
- **The subject line** is treated as text (entities decoded, slots not escaped). This is
  deliberately different from legacy, where the subject goes through pug and an `&` in a name
  arrives as `&amp;` in the subject line.

## Layout

```text
templates/*.mjml              the templates, and includes/ the parts they share
templates/<name>/*.pug        legacy's form of the same mails -- the importer's input,
locales/*.json                not the build's
po/<lang>/messages.po         the message catalogues, gettext
tests/__snapshots__/          every document as tools/runtime.mjs renders it, checked in
tools/                        extract_mjml.mjs, markers.mjs and gen_c.mjs (build time),
                              runtime.mjs (the reference renderer), values.mjs (the
                              test values), snapshots.mjs, verify.mjs (C vs snapshots),
                              preview.mjs + preview-page.html (the preview),
                              extract.mjs, compare_pug.mjs, json2po.mjs (the importer)
scripts/preview.ts            the preview server: bun serve + watch
include/service_core/email/   render.h, the renderer's public API
src/render.c                  its runtime half: ops, jumps, the modes, the arena
napi/                         the Node-API bindings and the version script
tls/                          the mbedTLS trim (MBEDTLS_USER_CONFIG_FILE)
scripts/                      the copy into fast-servers
build/tools/                  what the tools above write when they are run by hand:
                              mjml/ir.json, pug/ir.json, preview/, diff/. Generated,
                              so it lives under build/ and goes with a `build:clean`;
                              build/gen beside it is the build's own output
tests/                        `bun run test`; the addon, its TLS, the snapshots, the
                              markers, a person's text, the preview. They are written
                              against node:test, which both runtimes run, so `bun run
                              test:node` is the same suite on node -- the second
                              runtime the addon claims to serve. The send benchmark
                              in it skips unless BENCH=1, which `bun run bench` sets
```

`include/` and `src/` mirror the paths those two files have in `fast-servers/service-core`,
which is why there is one include spelling — `service_core/email.h` — and not two.
