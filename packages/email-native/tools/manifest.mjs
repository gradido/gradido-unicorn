// Where the tools find things, and the few build decisions that are not a property of
// any one template: the locales, how the plain text part is made, the inline images.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// The package root, so the defaults hold wherever node is invoked from.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Paths are arguments so that build.zig can collect the output in the build
// cache instead of in the source tree. The defaults are the templates this
// package carries -- imported from gradido's core/src/emails/templates, and the
// single source of truth for both implementations from here on.
const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

export const TEMPLATE_ROOT = path.resolve(arg('templates', path.join(ROOT, 'templates')))
export const LOCALE_DIR = path.resolve(arg('locales', path.join(ROOT, 'locales')))
// Under build/, which is the generated root `c-cpp-zig-build clean` takes away: what the
// tools write here is an intermediate, never a source, and nothing but a tool reads it.
export const OUT_DIR = path.resolve(arg('out', path.join(ROOT, 'build', 'tools')))
// The MJML output, checked in. tools/snapshots.mjs writes it, tests/snapshots.test.mjs
// and tools/verify.mjs compare against it.
export const SNAPSHOT_DIR = path.resolve(
  arg('snapshots', path.join(ROOT, 'tests', '__snapshots__')),
)
export const IR_PATH = path.resolve(arg('ir', path.join(OUT_DIR, 'ir.json')))

export const LOCALES = ['en', 'de', 'es', 'fr', 'nl', 'it', 'tr', 'ru', 'pt', 'el']

/*
 * The templates are the .mjml files in TEMPLATE_ROOT, in name order -- which is the
 * order of GE_TPL_* in the generated header. Everything a template needs to say about
 * itself (its values, its flags, its branches) is in the file.
 */
export const TEMPLATES = fs
  .readdirSync(TEMPLATE_ROOT)
  .filter((f) => f.endsWith('.mjml'))
  .map((f) => f.slice(0, -'.mjml'.length))
  .sort()

/*
 * How the HTML becomes the plain text alternative -- html-to-text, at build time, over the
 * *sentinel* HTML, so the slots survive into the text program and C fills them at runtime.
 *
 * Four decisions, and three of them are not cosmetic:
 *
 *   wordwrap off       Reflow would depend on the value in a slot, and then the text a caller
 *                      gets would not be the text this pipeline produced. Every line stays as
 *                      long as its content -- quoted-printable wraps it on the wire anyway.
 *   headings not
 *   uppercased         html-to-text uppercases h1-h6 by default, which would uppercase the
 *                      sentinel with them: \u0001FIRSTNAME\u0002 names no slot this renderer has.
 *   images skipped     Their formatter prints "alt src", and src is a cid: reference that means
 *                      nothing without the HTML part.
 *   .socialmedia
 *   skipped            Four icon links with no text: as plain text they are four bare URLs
 *                      glued together, which is worse than leaving them out.
 */
export const TEXT_OPTIONS_PUG = {
  wordwrap: false,
  selectors: [
    { selector: 'img', format: 'skip' },
    { selector: '.socialmedia', format: 'skip' },
    { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
    ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({
      selector,
      options: { uppercase: false },
    })),
  ],
}

// Inline attachments (cid:) referenced from layout/header/footer -- these go
// into the binary as bytes.
export const ASSETS = [
  ['gradidoheader', 'gradido-header.png', 'image/png'],
  ['facebookicon', 'facebook-icon.png', 'image/png'],
  ['telegramicon', 'telegram-icon.png', 'image/png'],
  ['twittericon', 'twitter-icon.png', 'image/png'],
  ['youtubeicon', 'youtube-icon.png', 'image/png'],
  ['chatboxicon', 'chatbox-icon.png', 'image/png'],
]

/*
 * What html-to-text makes of a rendered mail.
 *
 * `div` is the rule that matters and it is not a taste: MJML marks a paragraph up
 * as <div>, and html-to-text gives a <div> one newline where it gives a <p> a blank
 * line on each side. Without it a mail arrives as one dense block.
 *
 * TEXT_OPTIONS_PUG above is the same thing minus that rule, for tools/extract.mjs --
 * the importer, which reads legacy's pug and exists so a new template arriving there
 * can be checked against its MJML translation. It is not part of the build.
 */
export const TEXT_OPTIONS = {
  ...TEXT_OPTIONS_PUG,
  selectors: [
    ...TEXT_OPTIONS_PUG.selectors,
    { selector: 'div', options: { leadingLineBreaks: 2, trailingLineBreaks: 2 } },
  ],
}
