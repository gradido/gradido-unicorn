/* The e-mail renderer's API. It does not change when a template changes --
 * everything template-dependent is generated into service_core/email/templates.h out
 * of the MJML templates.
 *
 * A rendered document is a program of ops: slices of the static byte pool (memcpy),
 * values in one of a few modes, and jumps for the template's {{if}}s. No parser, no
 * per-op allocation, nothing to decompress. tools/runtime.mjs is the same machine in
 * JavaScript, and the snapshots hold the two to each other.
 *
 * The file belongs to packages/email-native. The copy under
 * fast-servers/service-core/include/service_core/email is written by that package's build
 * (scripts/sync-fast-servers.ts) and is overwritten by the next one, so a change
 * has to be made in packages/email-native/include/service_core/email/render.h.
 */
#ifndef SERVICE_CORE_EMAIL_RENDER_H
#define SERVICE_CORE_EMAIL_RENDER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    char  *data; /* NUL-terminated; release with ge_str_free */
    size_t len;
} ge_str_t;

typedef struct {
    ge_str_t subject;
    ge_str_t html;
    /* The plain text alternative, produced from the same document at build time -- see
     * tools/manifest.mjs, TEXT_OPTIONS. What a receiver without HTML is shown. */
    ge_str_t text;
} ge_mail_t;

/* An op is a pool slice unless its len is one of the kinds below; the low byte
 * of len is then the kind's argument.
 *
 *   GE_OP_SLOT | mode   value[off], written in that mode
 *   GE_OP_JZ   | i      jump to op off of the program unless value[i] is set
 *   GE_OP_JMP           jump to op off of the program
 *   GE_OP_BRK  | n      text only: n line breaks before the next output, merged
 *                       by max, dropped at the start and at the end
 *
 * A value is "set" when GE_HAS() says so; a flag is a value that is "1" or NULL. */
#define GE_OP_SLOT 0xFFFFFF00u
#define GE_OP_JZ   0xFFFFFE00u
#define GE_OP_JMP  0xFFFFFD00u
#define GE_OP_BRK  0xFFFFFC00u
#define GE_OP_KIND(len) ((len) >= GE_OP_BRK ? (len) & 0xFFFFFF00u : 0u)
#define GE_OP_ARG(len)  ((len) & 0xFFu)

enum {
    GE_MODE_HTML            = 0, /* HTML-escaped: & < > " */
    GE_MODE_RAW             = 1, /* as it is: the subject, the text part */
    GE_MODE_URI             = 2, /* one URI component, as encodeURIComponent writes it */
    GE_MODE_HUMAN           = 3, /* text a person typed: escaped, its addresses as links */
    GE_MODE_HUMAN_BOLD      = 4, /* the same, and **...** in bold */
    GE_MODE_HUMAN_TEXT      = 5, /* the two above for the text part */
    GE_MODE_HUMAN_BOLD_TEXT = 6,
};

typedef struct {
    uint32_t off;
    uint32_t len;
} ge_op_t;

typedef struct {
    uint32_t start;
    uint32_t count;
} ge_prog_t;

typedef struct {
    const char          *cid;
    const char          *filename;
    const char          *content_type;
    const unsigned char *data;
    size_t               size;
} ge_asset_t;

/* "set" means: not NULL and not empty -- what a template's {{if}} asks. */
#define GE_HAS(s) ((s) != NULL && (s)[0] != '\0')

/* Runs a program over the value vector sv (sv[0] is the locale code). Two passes:
 * length first, then exactly one malloc.
 * Returns 0 on success, -1 on out of memory. */
int  ge_run(const char *pool, const ge_op_t *ops, uint32_t count, const char *const *sv,
            ge_str_t *out);

void ge_str_free(ge_str_t *s);
void ge_mail_free(ge_mail_t *m);

/* --------------------------------------------------------------------------
 * Arena: one buffer that stands for the whole run and is merely reset per mail.
 * No malloc/free on the hot path. The ge_str_t point into the arena and must
 * NOT be freed -- they are valid until the next ge_arena_reset(). One arena
 * per thread.
 * -------------------------------------------------------------------------- */
typedef struct {
    char  *base;
    size_t cap;
    size_t used;
} ge_arena_t;

int  ge_arena_init(ge_arena_t *a, size_t cap);
void ge_arena_free(ge_arena_t *a);

/* Grows the arena to at least 'need' bytes. Discards the contents, so it may
 * only run when no ge_str_t is still in use -- meant for the case where
 * ge_run_into returns -1: grow, then render again. After that the arena is at
 * its final size and never allocates again. */
int  ge_arena_ensure(ge_arena_t *a, size_t need);

static inline void ge_arena_reset(ge_arena_t *a) { a->used = 0; }

/* Two passes, but checked: -1 if there is not enough room (out->len then holds
 * the requirement). */
int ge_run_into(const char *pool, const ge_op_t *ops, uint32_t count, const char *const *sv,
                ge_arena_t *a, ge_str_t *out);

/* One pass, unchecked. The caller guarantees the room -- via
 * GE_BUF_SIZE(max_field) plus a length check on the inputs. Otherwise it writes
 * past the end of the buffer. */
int ge_run_into_fast(const char *pool, const ge_op_t *ops, uint32_t count,
                     const char *const *slots, ge_arena_t *a, ge_str_t *out);

#endif /* SERVICE_CORE_EMAIL_RENDER_H */
