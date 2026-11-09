/* Two questions:
 *   1. How big does a buffer have to be to hold the largest mail?
 *   2. What does a reused buffer buy over malloc/free per mail?
 */
#define _POSIX_C_SOURCE 200809L
#include "service_core/email/templates.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define MAX_SLOTS 32
#define PROBE_ARENA (4u << 20)

static double now(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}

/* ------------------------------------------------------------------- 1) size
 * Every slot gets 'field' bytes of '"' -- six output bytes per input byte in the
 * HTML -- and every flag is set, so every branch is taken. GE_BUF_SIZE is the bound
 * for any input; this is what the plain worst character actually costs. */
static void probe(size_t field, ge_arena_t *a)
{
    char *worst = (char *)malloc(field + 1);
    memset(worst, '"', field);
    worst[field] = '\0';

    size_t   max = 0;
    unsigned max_t = 0, max_l = 0;
    const char *sv[MAX_SLOTS];
    bool        flags[MAX_SLOTS];
    for (int i = 0; i < MAX_SLOTS; i++) { sv[i] = worst; flags[i] = true; }

    for (int t = 0; t < GE_TPL_COUNT; t++) {
        for (int l = 0; l < GE_LOCALE_COUNT; l++) {
            ge_mail_t m;
            ge_arena_reset(a);
            if (ge_render_values_into((ge_template_t)t, (ge_locale_t)l, sv, flags, a, &m) != 0) {
                fprintf(stderr, "probe arena too small\n");
                exit(1);
            }
            size_t total = m.html.len + m.subject.len + m.text.len + 3; /* three NULs */
            if (total > max) { max = total; max_t = t; max_l = l; }
        }
    }
    printf("  %5zu B/field  ->  %7zu B  (%5.1f KB)   largest: %s/%s\n", field, max,
           max / 1024.0, GE_TEMPLATES[max_t].name, ge_locale_code((ge_locale_t)max_l));
    free(worst);
}

/* -------------------------------------------------------------- 2) throughput */
static const ge_account_activation_t V = {
    .first_name      = "Björn",
    .last_name       = "Müller & Söhne",
    .activation_link = "https://gradido.net/activate?code=abcdef0123456789abcdef&t=1",
    .logo_url        = NULL,
    .hours           = "23",
    .minutes         = "59",
    .resend_link     = "https://gradido.net/resend?code=abcdef0123456789abcdef",
};

#define TIMEIT(label, N, body)                                                                    \
    do {                                                                                          \
        double t0 = now();                                                                        \
        for (int i = 0; i < (N); i++) { body }                                                     \
        double dt = now() - t0;                                                                   \
        printf("  %-34s %8.0f ns/mail   %8.2f M/s   %6.1f GB/s\n", label, dt / (N) * 1e9,          \
               (N) / dt / 1e6, sink / dt / 1e9);                                                  \
        sink = 0;                                                                                 \
    } while (0)

int main(void)
{
    ge_arena_t arena;
    if (ge_arena_init(&arena, PROBE_ARENA) != 0) return 1;

    printf("Static share (template bytes only, no user data):\n");
    printf("  html max %u B, subject max %u B, together %u B (%.1f KB)\n", GE_MAX_STATIC_HTML,
           GE_MAX_STATIC_SUBJECT, GE_MAX_STATIC_HTML + GE_MAX_STATIC_SUBJECT + 2,
           (GE_MAX_STATIC_HTML + GE_MAX_STATIC_SUBJECT + 2) / 1024.0);
    printf("  at most %u slot uses per document\n\n", GE_MAX_SLOT_REFS);

    printf("Measured worst case over all %d templates x %d locales, every branch taken,\n"
           "every field filled with '\"' (6 output bytes per input byte):\n",
           GE_TPL_COUNT, GE_LOCALE_COUNT);
    for (size_t f = 64; f <= 2048; f *= 2) probe(f, &arena);
    printf("\n");

    /* Cross-check: the arena produces exactly what malloc produces. */
    ge_mail_t ma, mb;
    ge_render_account_activation(GE_LOCALE_DE, &V, &ma);
    ge_arena_reset(&arena);
    ge_render_account_activation_into_fast(GE_LOCALE_DE, &V, &arena, &mb);
    if (ma.html.len != mb.html.len || memcmp(ma.html.data, mb.html.data, ma.html.len) != 0) {
        fprintf(stderr, "arena != malloc\n");
        return 1;
    }
    size_t doc = ma.html.len + ma.subject.len;
    ge_mail_free(&ma);
    printf("Throughput, accountActivation/de, %zu B per mail (html+subject):\n", doc);

    const int N = 2000000;
    size_t    sink = 0;

    TIMEIT("malloc/free per mail", N, {
        ge_mail_t m;
        ge_render_account_activation(GE_LOCALE_DE, &V, &m);
        sink += m.html.len + m.subject.len;
        ge_mail_free(&m);
    });

    TIMEIT("arena, checked (2 passes)", N, {
        ge_mail_t m;
        ge_arena_reset(&arena);
        ge_render_account_activation_into(GE_LOCALE_DE, &V, &arena, &m);
        sink += m.html.len + m.subject.len;
    });

    TIMEIT("arena, single pass", N, {
        ge_mail_t m;
        ge_arena_reset(&arena);
        ge_render_account_activation_into_fast(GE_LOCALE_DE, &V, &arena, &m);
        sink += m.html.len + m.subject.len;
    });

    /* Mixed load: all templates and locales in turn, so this does not just
     * measure one hot cache path. */
    const char *sv[MAX_SLOTS];
    bool        flags[MAX_SLOTS];
    for (int i = 0; i < MAX_SLOTS; i++) { sv[i] = "Müller & Söhne <test@gradido.net>"; flags[i] = true; }
    const int M = 500000;
    printf("\nMixed across all templates and locales:\n");

    TIMEIT("malloc/free per mail", M, {
        ge_mail_t m;
        int       t = i % GE_TPL_COUNT;
        ge_render_values((ge_template_t)t, (ge_locale_t)(i % GE_LOCALE_COUNT), sv, flags, &m);
        sink += m.html.len + m.subject.len;
        ge_mail_free(&m);
    });

    TIMEIT("arena, single pass", M, {
        ge_mail_t m;
        int       t = i % GE_TPL_COUNT;
        ge_arena_reset(&arena);
        ge_render_values_into_fast((ge_template_t)t, (ge_locale_t)(i % GE_LOCALE_COUNT), sv, flags,
                                   &arena, &m);
        sink += m.html.len + m.subject.len;
    });

    ge_arena_free(&arena);
    return 0;
}
