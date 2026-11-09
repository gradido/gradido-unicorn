/* The runtime half of the renderer, template-independent like its header.
 *
 * The file belongs to packages/email-native. The copy under
 * fast-servers/service-core/src/email is written by that package's build
 * (scripts/sync-fast-servers.ts) and is overwritten by the next one, so a change has
 * to be made in packages/email-native/src/render.c.
 *
 * tools/runtime.mjs is this file in JavaScript. The snapshots are rendered by that one
 * and `zig build check` holds this one to them, byte for byte. */
#include "service_core/email/render.h"

#include <stdlib.h>
#include <string.h>

/* One writer for both passes: with d == NULL it only counts. Counting and writing
 * then cannot disagree about a length, which is what the arena relies on. */
typedef struct {
    char  *d;
    size_t n;
} ge_out_t;

static void ge_put(ge_out_t *o, const char *s, size_t n)
{
    if (o->d) memcpy(o->d + o->n, s, n);
    o->n += n;
}

#define GE_PUT_LIT(o, lit) ge_put((o), (lit), sizeof(lit) - 1)

/* Exactly the four characters pug and tools/runtime.mjs escape. The position is a
 * local and not o->n: every store through a char * may alias a size_t in memory, and
 * the hot loop would reload it after each byte. */
static size_t ge_esc_into(char *d, size_t n, const char *s, size_t len)
{
    /* Runs without an escapable character are copied whole; they are nearly all of it. */
    static const unsigned char special[256] = { ['&'] = 1, ['<'] = 2, ['>'] = 3, ['"'] = 4 };
    static const char *const   entity[5]    = { "", "&amp;", "&lt;", "&gt;", "&quot;" };
    static const unsigned char entity_len[5] = { 0, 5, 4, 4, 6 };
    size_t i = 0;
    while (i < len) {
        size_t j = i;
        while (j < len && !special[(unsigned char)s[j]]) j++;
        if (d) memcpy(d + n, s + i, j - i);
        n += j - i;
        if (j == len) break;
        unsigned e = special[(unsigned char)s[j]];
        if (d) memcpy(d + n, entity[e], entity_len[e]);
        n += entity_len[e];
        i = j + 1;
    }
    return n;
}

static void ge_put_esc(ge_out_t *o, const char *s, size_t len)
{
    o->n = ge_esc_into(o->d, o->n, s, len);
}

/* encodeURIComponent: everything but A-Z a-z 0-9 - _ . ! ~ * ' ( ) as %XX, byte by
 * byte of the UTF-8. Nothing it leaves needs HTML escaping, so one mode serves both
 * parts. At most 3 bytes per byte. */
static void ge_put_uri(ge_out_t *o, const char *s, size_t n)
{
    static const char hex[] = "0123456789ABCDEF";
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
            (c && strchr("-_.!~*'()", c))) {
            if (o->d) o->d[o->n] = (char)c;
            o->n++;
        } else {
            char e[3] = { '%', hex[c >> 4], hex[c & 15] };
            ge_put(o, e, 3);
        }
    }
}

/* ------------------------------------------------------------ human text
 *
 * Text a person typed, with its web and e-mail addresses as links and, in the bold
 * modes, **...** in bold: legacy's core/src/logic/HumanText.logic.ts, whose patterns
 * are the wallet's. This is those three regular expressions by hand,
 *
 *   URL    /\b(?:https?|ftp):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|]/gi
 *   EMAIL  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
 *   BOLD   /\*\*([\s\S]+?)\*\*\/g
 *
 * applied as legacy applies them: web addresses over the whole value, e-mail
 * addresses only between them, bold only between those -- each with the leftmost
 * match first, and \b relative to the piece being searched. Every pattern is ASCII,
 * so a byte >= 0x80 is neither a word character nor in any class, in UTF-8 here as in
 * UTF-16 there. tests/human_text.test.mjs runs the addon against tools/runtime.mjs.
 *
 * Nothing a person typed reaches the mail as markup: every piece goes through
 * ge_put_esc, the link text is always the address itself.
 *
 * What a mode makes of a byte at most, for GE_BUF_SIZE: a link of n >= 7 bytes is
 * `<a href="` + 2 x escaped + `">` `</a>`, 15 + 2 x 5(n - 6) + 2 x 6 < 10n; a mail
 * address (no escapable characters) 22 + 2n < 6n for n >= 6; bold 17 + 6(n - 4) < 6n;
 * text 6n. So 10. The text modes add " [" "]" to a shortened link: 2n + 3 < 3n. */

static int ge_is_word(unsigned char c)
{
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_';
}
static int ge_is_alpha(unsigned char c) { return (c | 0x20) >= 'a' && (c | 0x20) <= 'z'; }
static int ge_is_alnum(unsigned char c) { return ge_is_alpha(c) || (c >= '0' && c <= '9'); }
static int ge_in(unsigned char c, const char *set) { return c && strchr(set, c) != NULL; }

static int ge_url_mid(unsigned char c) { return ge_is_alnum(c) || ge_in(c, "-+&@#/%?=~_|!:,.;"); }
static int ge_url_end(unsigned char c) { return ge_is_alnum(c) || ge_in(c, "-+&@#/%=~_|"); }
static int ge_mail_local(unsigned char c) { return ge_is_alnum(c) || ge_in(c, "._%+-"); }
static int ge_mail_domain(unsigned char c) { return ge_is_alnum(c) || ge_in(c, ".-"); }

static int ge_ci(const char *s, size_t n, size_t at, const char *lower)
{
    size_t k = strlen(lower);
    if (at + k > n) return 0;
    for (size_t i = 0; i < k; i++)
        if ((s[at + i] | (s[at + i] >= 'A' && s[at + i] <= 'Z' ? 0x20 : 0)) != lower[i]) return 0;
    return 1;
}

/* The length of the web address starting at i, or 0. */
static size_t ge_url_at(const char *s, size_t n, size_t i)
{
    if (i > 0 && ge_is_word((unsigned char)s[i - 1])) return 0;
    size_t j;
    if (ge_ci(s, n, i, "http")) {
        if (ge_ci(s, n, i + 4, "s://")) j = i + 8;
        else if (ge_ci(s, n, i + 4, "://")) j = i + 7;
        else return 0;
    } else if (ge_ci(s, n, i, "ftp://")) {
        j = i + 6;
    } else {
        return 0;
    }
    size_t k = j;
    while (k < n && ge_url_mid((unsigned char)s[k])) k++;
    while (k > j && !ge_url_end((unsigned char)s[k - 1])) k--;
    return k > j ? k - i : 0;
}

/* A video invitation of the wallet's own form shows its room: the address up to the
 * '#', when what follows is exactly `#config.subject=<topic>` and optionally
 * `&gradido.start=<1-12 digits>&gradido.end=<1-12 digits>`. Otherwise 0. */
static size_t ge_room(const char *u, size_t n)
{
    const char *hash = memchr(u, '#', n);
    if (!hash || hash == u) return 0;
    size_t h = (size_t)(hash - u);
    static const char subject[] = "#config.subject=", start[] = "&gradido.start=",
                      end[] = "&gradido.end=";
    if (n - h < sizeof subject - 1 || memcmp(u + h, subject, sizeof subject - 1) != 0) return 0;
    size_t q = h + sizeof subject - 1;
    while (q < n && u[q] != '&' && u[q] != '#') q++;
    if (q == n) return h;
    if (u[q] == '#') return 0;
    for (int part = 0; part < 2; part++) {
        const char *lit = part ? end : start;
        size_t      len = part ? sizeof end - 1 : sizeof start - 1;
        if (n - q < len || memcmp(u + q, lit, len) != 0) return 0;
        q += len;
        size_t d = 0;
        while (q + d < n && u[q + d] >= '0' && u[q + d] <= '9') d++;
        if (d < 1 || d > 12) return 0;
        q += d;
    }
    return q == n ? h : 0;
}

/* The end of `[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b` starting at j inside [., b), or 0. */
static size_t ge_mail_domain_end(const char *s, size_t j, size_t b)
{
    size_t m = j;
    while (m < b && ge_mail_domain((unsigned char)s[m])) m++;
    for (size_t q = m; q-- > j + 1;) {
        if (s[q] != '.') continue;
        size_t r = q + 1;
        while (r < b && ge_is_alpha((unsigned char)s[r])) r++;
        if (r - (q + 1) >= 2 && (r == b || !ge_is_word((unsigned char)s[r]))) return r;
    }
    return 0;
}

/* The first e-mail address in [p, b) of the piece [a, b): its start, its end in *end. */
static size_t ge_mail_find(const char *s, size_t a, size_t p, size_t b, size_t *end)
{
    size_t i = p;
    while (i < b) {
        if (!ge_mail_local((unsigned char)s[i])) { i++; continue; }
        size_t k = i;
        while (k < b && ge_mail_local((unsigned char)s[k])) k++;
        size_t r = k < b && s[k] == '@' ? ge_mail_domain_end(s, k + 1, b) : 0;
        if (r) {
            for (size_t x = i; x < k; x++) {
                int before = x > a && ge_is_word((unsigned char)s[x - 1]);
                if (before != ge_is_word((unsigned char)s[x])) {
                    *end = r;
                    return x;
                }
            }
        }
        i = k;
    }
    return b;
}

static void ge_put_text(ge_out_t *o, const char *s, size_t n, int html)
{
    if (html) ge_put_esc(o, s, n);
    else ge_put(o, s, n);
}

static void ge_put_plain(ge_out_t *o, const char *s, size_t a, size_t b, int bold, int html)
{
    while (bold && a < b) {
        const char *open = NULL;
        for (size_t i = a; i + 1 < b; i++)
            if (s[i] == '*' && s[i + 1] == '*') { open = s + i; break; }
        if (!open) break;
        size_t i = (size_t)(open - s), j = i + 3;
        while (j + 1 < b && !(s[j] == '*' && s[j + 1] == '*')) j++;
        if (j + 1 >= b) break;
        ge_put_text(o, s + a, i - a, html);
        if (html) GE_PUT_LIT(o, "<strong>");
        ge_put_text(o, s + i + 2, j - i - 2, html);
        if (html) GE_PUT_LIT(o, "</strong>");
        a = j + 2;
    }
    ge_put_text(o, s + a, b - a, html);
}

static void ge_put_mails(ge_out_t *o, const char *s, size_t a, size_t b, int bold, int html)
{
    size_t p = a;
    while (p < b) {
        size_t end = 0, at = ge_mail_find(s, a, p, b, &end);
        ge_put_plain(o, s, p, at, bold, html);
        if (at == b) break;
        if (html) {
            GE_PUT_LIT(o, "<a href=\"mailto:");
            ge_put_esc(o, s + at, end - at);
            GE_PUT_LIT(o, "\">");
            ge_put_esc(o, s + at, end - at);
            GE_PUT_LIT(o, "</a>");
        } else {
            ge_put(o, s + at, end - at);
        }
        p = end;
    }
}

static void ge_put_human(ge_out_t *o, const char *s, size_t n, int bold, int html)
{
    size_t p = 0;
    while (p < n) {
        size_t i = p, len = 0;
        for (; i < n; i++)
            if ((len = ge_url_at(s, n, i)) != 0) break;
        ge_put_mails(o, s, p, i, bold, html);
        if (i == n) break;
        size_t room = ge_room(s + i, len);
        if (html) {
            GE_PUT_LIT(o, "<a href=\"");
            ge_put_esc(o, s + i, len);
            GE_PUT_LIT(o, "\">");
            ge_put_esc(o, s + i, room ? room : len);
            GE_PUT_LIT(o, "</a>");
        } else if (room) {
            /* what html-to-text makes of a link whose text is not its address */
            ge_put(o, s + i, room);
            GE_PUT_LIT(o, " [");
            ge_put(o, s + i, len);
            GE_PUT_LIT(o, "]");
        } else {
            ge_put(o, s + i, len);
        }
        p = i + len;
    }
}

/* ------------------------------------------------------------------ the machine */

/* The rare modes -- a URI component, a person's text -- go through ge_out_t; the
 * literals and the escaped values, which are nearly every byte, stay in locals. */
static size_t ge_put_value(char *d, size_t n, const char *v, unsigned mode)
{
    size_t   len = strlen(v);
    ge_out_t o   = { d, n };
    switch (mode) {
    case GE_MODE_HTML:            return ge_esc_into(d, n, v, len);
    case GE_MODE_URI:             ge_put_uri(&o, v, len); break;
    case GE_MODE_HUMAN:           ge_put_human(&o, v, len, 0, 1); break;
    case GE_MODE_HUMAN_BOLD:      ge_put_human(&o, v, len, 1, 1); break;
    case GE_MODE_HUMAN_TEXT:      ge_put_human(&o, v, len, 0, 0); break;
    case GE_MODE_HUMAN_BOLD_TEXT: ge_put_human(&o, v, len, 1, 0); break;
    default:
        if (d) memcpy(d + n, v, len);
        return n + len;
    }
    return o.n;
}

/* One machine for both passes: with d == NULL it only counts, so counting and writing
 * cannot disagree about a length -- which the arena relies on. Inlined into the two
 * callers below, each gets a copy with the d tests folded away. */
static inline __attribute__((always_inline)) size_t
ge_exec(char *d, const char *pool, const ge_op_t *ops, uint32_t count, const char *const *sv)
{
    size_t   n       = 0;
    unsigned pending = 0;
    uint32_t i       = 0;
    while (i < count) {
        const ge_op_t op = ops[i++];
        if (__builtin_expect(op.len < GE_OP_BRK, 1)) { /* a pool slice: nearly every op */
            if (__builtin_expect(pending != 0, 0)) {
                for (; pending && n; pending--) { if (d) d[n] = '\n'; n++; }
                pending = 0;
            }
            if (d) memcpy(d + n, pool + op.off, op.len);
            n += op.len;
            continue;
        }
        switch (op.len & 0xFFFFFF00u) {
        case GE_OP_SLOT: {
            const char *v = sv[op.off];
            if (!GE_HAS(v)) break;
            for (; pending && n; pending--) { if (d) d[n] = '\n'; n++; }
            pending = 0;
            n = ge_put_value(d, n, v, GE_OP_ARG(op.len));
            break;
        }
        case GE_OP_JZ:
            if (!GE_HAS(sv[GE_OP_ARG(op.len)])) i = op.off;
            break;
        case GE_OP_JMP:
            i = op.off;
            break;
        default: /* GE_OP_BRK */
            if (GE_OP_ARG(op.len) > pending) pending = GE_OP_ARG(op.len);
            break;
        }
    }
    return n;
}

static size_t ge_needed(const char *pool, const ge_op_t *ops, uint32_t count,
                        const char *const *sv)
{
    return ge_exec(NULL, pool, ops, count, sv);
}

static size_t ge_write(char *d, const char *pool, const ge_op_t *ops, uint32_t count,
                       const char *const *sv)
{
    return ge_exec(d, pool, ops, count, sv);
}

int ge_run(const char *pool, const ge_op_t *ops, uint32_t count, const char *const *sv,
           ge_str_t *out)
{
    char *d = (char *)malloc(ge_needed(pool, ops, count, sv) + 1);
    if (!d) {
        out->data = NULL;
        out->len  = 0;
        return -1;
    }
    size_t n  = ge_write(d, pool, ops, count, sv);
    d[n]      = '\0';
    out->data = d;
    out->len  = n;
    return 0;
}

void ge_str_free(ge_str_t *s)
{
    free(s->data);
    s->data = NULL;
    s->len  = 0;
}

void ge_mail_free(ge_mail_t *m)
{
    ge_str_free(&m->subject);
    ge_str_free(&m->html);
    ge_str_free(&m->text);
}

/* ------------------------------------------------------------------ arena */

int ge_arena_init(ge_arena_t *a, size_t cap)
{
    a->base = (char *)malloc(cap);
    a->cap  = a->base ? cap : 0;
    a->used = 0;
    return a->base ? 0 : -1;
}

int ge_arena_ensure(ge_arena_t *a, size_t need)
{
    if (a->cap >= need) return 0;
    size_t want = a->cap * 2 > need ? a->cap * 2 : need;
    char  *p    = (char *)realloc(a->base, want);
    if (!p) return -1;
    a->base = p;
    a->cap  = want;
    a->used = 0;
    return 0;
}

void ge_arena_free(ge_arena_t *a)
{
    free(a->base);
    a->base = NULL;
    a->cap = a->used = 0;
}

int ge_run_into(const char *pool, const ge_op_t *ops, uint32_t count, const char *const *sv,
                ge_arena_t *a, ge_str_t *out)
{
    size_t need = ge_needed(pool, ops, count, sv) + 1;
    if (a->cap - a->used < need) {
        out->data = NULL;
        out->len  = need;
        return -1;
    }
    return ge_run_into_fast(pool, ops, count, sv, a, out);
}

int ge_run_into_fast(const char *pool, const ge_op_t *ops, uint32_t count,
                     const char *const *sv, ge_arena_t *a, ge_str_t *out)
{
    char  *d = a->base + a->used;
    size_t n = ge_write(d, pool, ops, count, sv);
    d[n]     = '\0';
    a->used += n + 1;
    out->data = d;
    out->len  = n;
    return 0;
}
