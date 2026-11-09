/* Renders everything that is in the binary with fixed test values into a
 * directory. Counterpart to tools/verify.mjs.
 *
 * One document per template, locale and value set: set 0 has every value set, each
 * further one leaves some unset to reach another case of a branch -- the same sets,
 * in the same order, as tools/values.mjs. */
#include "service_core/email/templates.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* identical to fixture() in tools/values.mjs: every character HTML escapes, one it
 * does not, a non-ASCII one, and what a person's text turns into links and bold. */
#define GE_FIXTURE                                                                       \
    "{%s|&<>\"'\xc3\xa4 **b** https://x.example/r#config.subject=%%22T%%22 ftp://y.example/a. " \
    "m@x.example}"

/* generated into test_sets.c by tools/gen_c.mjs */
extern const struct { unsigned n_sets; const unsigned short *cleared; } GE_TEST_SETS[GE_TPL_COUNT];

static void write_file(const char *dir, const char *tpl, const char *loc, unsigned set,
                       const char *ext, const ge_str_t *s)
{
    char path[512];
    snprintf(path, sizeof path, "%s/%s.%s.%u.%s", dir, tpl, loc, set, ext);
    FILE *f = fopen(path, "wb");
    if (!f) { perror(path); exit(1); }
    fwrite(s->data, 1, s->len, f);
    fclose(f);
}

int main(int argc, char **argv)
{
    const char *dir = argc > 1 ? argv[1] : "out/c";
    size_t      bytes = 0;
    unsigned    n = 0;

    for (int t = 0; t < GE_TPL_COUNT; t++) {
        const ge_template_info_t *ti = &GE_TEMPLATES[t];
        const char *sv[GE_MAX_VALUES];
        bool        flags[GE_MAX_VALUES];
        char        buf[GE_MAX_VALUES][256];

        const unsigned short *c = GE_TEST_SETS[t].cleared;
        for (unsigned set = 0; set < GE_TEST_SETS[t].n_sets; set++) {
            sv[0] = NULL; /* the renderer sets this one */
            for (uint32_t s = 1; s < ti->n_slots; s++) {
                /* identical to fixture() in tools/values.mjs */
                snprintf(buf[s], sizeof buf[s], GE_FIXTURE, ti->slot_names[s]);
                sv[s] = buf[s];
            }
            for (uint32_t f = 0; f < ti->n_flags; f++) flags[f] = true;
            for (unsigned k = *c++; k > 0; k--) {
                unsigned v = *c++;
                if (v < ti->n_slots) sv[v] = "";
                else flags[v - ti->n_slots] = false;
            }

            for (int l = 0; l < GE_LOCALE_COUNT; l++) {
                ge_mail_t m;
                if (ge_render_values((ge_template_t)t, (ge_locale_t)l, sv, flags, &m) != 0) {
                    fprintf(stderr, "render failed: %s/%s/%u\n", ti->name, ge_locale_code(l), set);
                    return 1;
                }
                if (m.html.len != strlen(m.html.data)) {
                    fprintf(stderr, "embedded NUL in %s\n", ti->name);
                    return 1;
                }
                write_file(dir, ti->name, ge_locale_code(l), set, "html", &m.html);
                write_file(dir, ti->name, ge_locale_code(l), set, "subject", &m.subject);
                write_file(dir, ti->name, ge_locale_code(l), set, "text", &m.text);
                bytes += m.html.len + m.subject.len + m.text.len;
                n += 3;
                ge_mail_free(&m);
            }
        }
    }
    fprintf(stderr, "%u documents, %.1f KB rendered\n", n, bytes / 1024.0);
    return 0;
}
