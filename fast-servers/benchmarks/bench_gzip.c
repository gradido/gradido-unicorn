/*
 * What gzip costs per response, through h2o's own compressor.
 *
 * h2o's compress filter opens a fresh gzip context per response (h2o_compress_gzip_open:
 * deflateInit2 with windowBits 31, memLevel 8), runs it once over the body and frees it with
 * the request's pool. That is what a server pays when it says `Accept-Encoding: gzip` is
 * honoured, and it is paid on the loop thread, for every response, so it competes with the
 * request path directly.
 *
 * The bodies are the two shapes a feed API answers with: a feed of twenty posts (the
 * expensive one, several KB) and one post (a few hundred bytes, where the fixed cost of a
 * deflate stream dominates). Both are synthetic, built from a word list, so the ratio is
 * indicative and the time is real.
 *
 * Three rows per quality, so the cost is read in parts:
 *   h2o: open + transform + free    what the filter costs, and the row to quote
 *   zlib: stream kept, reset        the same deflate with the stream reused -- what a
 *                                   per-loop compressor would save
 *   deflateInit2 + deflateEnd       the setup alone; the difference is the allocation
 *
 * The last column converts the row to cores at the request rate given on the command line
 * (default 42,000 /s, the million-user load profile), which is the number that decides
 * whether this belongs on the loop.
 *
 * Everything runs twice: with glibc's malloc as it comes, and with heap trimming turned off
 * (mallopt M_TRIM_THRESHOLD and M_TOP_PAD). A deflate stream is about 270 KB, which is above
 * glibc's trim threshold, so freeing it gives the pages back to the kernel and the next
 * deflateInit2 takes them again through page faults -- that is what the setup row measures
 * under the default, and the second pass shows what is left of it once the heap keeps them.
 *
 * Numbers move with the machine and with the zlib underneath. Report both beside them, and
 * build with --release=fast: a Debug build measures Debug.
 */
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <zlib.h>
#ifdef __GLIBC__
#include <malloc.h>
#endif

#include "h2o.h"

#define FEED_ROUNDS 20000
#define POST_ROUNDS 100000

static double req_per_s = 42000.0;

static double now_ns(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1e9 + (double)ts.tv_nsec;
}

/* ---- the bodies ----------------------------------------------------------------------- */

static const char *const WORDS[] = {
    "the",     "feed",    "scrolls", "past",     "another", "morning", "coffee",  "and",
    "a",       "server",  "that",    "holds",    "million", "users",   "without", "nginx",
    "we",      "measure", "before",  "we",       "argue",   "about",   "it",      "gradido",
    "commons", "post",    "like",    "timeline", "today",   "tomorrow", "quietly", "fast",
    "latency", "p99",     "commit",  "before",   "answer",  "keep",    "alive",   "idle",
};
#define NWORDS (sizeof(WORDS) / sizeof(WORDS[0]))

static uint32_t rng_state = 0x9e3779b9u;
static uint32_t rng(void)
{
    /* xorshift32: deterministic, so two runs compress the same bytes */
    uint32_t x = rng_state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return rng_state = x;
}

/* A post body of @p target characters, built from the word list. */
static size_t make_text(char *dst, size_t cap, size_t target)
{
    size_t len = 0;
    while (len < target) {
        const char *w = WORDS[rng() % NWORDS];
        size_t wl = strlen(w);
        if (len + wl + 1 >= cap)
            break;
        if (len != 0)
            dst[len++] = ' ';
        memcpy(dst + len, w, wl);
        len += wl;
    }
    dst[len] = '\0';
    return len;
}

/* One post object in the shape of the spec: id, body, created_at, author, like_count. */
static int make_post(char *dst, size_t cap, int64_t id, size_t text_len)
{
    char text[600];
    make_text(text, sizeof(text), text_len);
    return snprintf(dst, cap,
                    "{\"id\":%" PRId64 ",\"body\":\"%s\",\"created_at\":\"2026-10-%02u"
                    "T%02u:%02u:%02u.%03uZ\",\"author\":\"user_%u\",\"like_count\":%u}",
                    id, text, 1 + rng() % 28, rng() % 24, rng() % 60, rng() % 60, rng() % 1000,
                    1 + rng() % 50000, rng() % 60);
}

static size_t make_feed(char *dst, size_t cap)
{
    size_t len = 0;
    len += (size_t)snprintf(dst + len, cap - len, "{\"posts\":[");
    for (int i = 0; i != 20; ++i) {
        /* 30..400 characters, the long tail a real feed has */
        size_t text_len = 30 + rng() % 370;
        if (i != 0)
            dst[len++] = ',';
        len += (size_t)make_post(dst + len, cap - len, 500000 - i * 7, text_len);
    }
    len += (size_t)snprintf(dst + len, cap - len, "]}");
    return len;
}

/* ---- the rows ------------------------------------------------------------------------- */

static void header(const char *what, size_t body_len, long rounds)
{
    printf("\n%s: %zu bytes, %ld rounds\n", what, body_len, rounds);
    printf("  %-38s %9s %9s %7s %8s %7s\n", "", "ns/resp", "MB/s in", "out B", "ratio", "cores");
}

static void report(const char *label, double elapsed_ns, long rounds, size_t in_len, size_t out_len)
{
    const double per = elapsed_ns / (double)rounds;
    printf("  %-38s %9.0f %9.1f", label, per, (double)in_len * 1e3 / per);
    if (out_len != 0)
        printf(" %7zu %7.2fx", out_len, (double)in_len / (double)out_len);
    else
        printf(" %7s %8s", "-", "-");
    printf(" %7.2f\n", per * req_per_s / 1e9);
}

/* h2o's filter, as it runs per response: open on the request pool, one transform with the
 * whole body and the FINAL state, and the pool clearing it. */
static size_t h2o_gzip_once(const char *body, size_t len, int quality, char *check, size_t check_cap)
{
    h2o_mem_pool_t pool;
    h2o_compress_context_t *ctx;
    h2o_sendvec_t in;
    h2o_sendvec_t *out;
    size_t outcnt, total = 0;

    h2o_mem_init_pool(&pool);
    ctx = h2o_compress_gzip_open(&pool, quality);
    h2o_sendvec_init_raw(&in, body, len);
    ctx->do_transform(ctx, &in, 1, H2O_SEND_STATE_FINAL, &out, &outcnt);
    for (size_t i = 0; i != outcnt; ++i) {
        if (check != NULL && total + out[i].len <= check_cap)
            memcpy(check + total, out[i].raw, out[i].len);
        total += out[i].len;
    }
    h2o_mem_clear_pool(&pool);
    return total;
}

/* The same deflate with the stream kept across responses -- what a compressor owned by the
 * loop would pay. Same parameters as gzip.c: windowBits 31 (gzip wrapper), memLevel 8. */
static size_t zlib_reset_once(z_stream *zs, const char *body, size_t len, unsigned char *out, size_t out_cap)
{
    deflateReset(zs);
    zs->next_in = (Bytef *)body;
    zs->avail_in = (uInt)len;
    zs->next_out = out;
    zs->avail_out = (uInt)out_cap;
    int ret = deflate(zs, Z_FINISH);
    if (ret != Z_STREAM_END) {
        fprintf(stderr, "deflate: %d\n", ret);
        exit(1);
    }
    return out_cap - zs->avail_out;
}

/* Round-trips the compressed bytes through h2o's gunzip, once, so the rows above are known
 * to measure a stream a client can read. */
static int verify(const char *body, size_t len, const char *gz, size_t gz_len)
{
    h2o_mem_pool_t pool;
    h2o_compress_context_t *ctx;
    h2o_sendvec_t in;
    h2o_sendvec_t *out;
    size_t outcnt, pos = 0;
    int ok = 1;

    h2o_mem_init_pool(&pool);
    ctx = h2o_compress_gunzip_open(&pool);
    h2o_sendvec_init_raw(&in, gz, gz_len);
    ctx->do_transform(ctx, &in, 1, H2O_SEND_STATE_FINAL, &out, &outcnt);
    for (size_t i = 0; i != outcnt && ok; ++i) {
        if (pos + out[i].len > len || memcmp(body + pos, out[i].raw, out[i].len) != 0)
            ok = 0;
        pos += out[i].len;
    }
    h2o_mem_clear_pool(&pool);
    return ok && pos == len;
}

static void bench_body(const char *what, const char *body, size_t len, long rounds)
{
    static const int qualities[] = {1, 2, 3, 6, 9};
    char label[64];
    char gz[65536];
    unsigned char out[65536];
    double t0;
    size_t out_len = 0;
    uint64_t sink = 0;

    header(what, len, rounds);

    t0 = now_ns();
    for (long i = 0; i < rounds; ++i) {
        memcpy(out, body, len);
        sink += out[i % len];
    }
    report("memcpy of the body (no compression)", now_ns() - t0, rounds, len, 0);

    for (size_t q = 0; q != sizeof(qualities) / sizeof(qualities[0]); ++q) {
        const int quality = qualities[q];

        /* warm up, and keep one output for the check */
        out_len = h2o_gzip_once(body, len, quality, gz, sizeof(gz));
        if (!verify(body, len, gz, out_len)) {
            fprintf(stderr, "gzip quality %d: round trip failed\n", quality);
            exit(1);
        }

        t0 = now_ns();
        for (long i = 0; i < rounds; ++i)
            sink += h2o_gzip_once(body, len, quality, NULL, 0);
        snprintf(label, sizeof(label), "h2o gzip q%d: open + transform + free", quality);
        report(label, now_ns() - t0, rounds, len, out_len);

        {
            z_stream zs;
            memset(&zs, 0, sizeof(zs));
            deflateInit2(&zs, quality, Z_DEFLATED, 31, 8, Z_DEFAULT_STRATEGY);
            t0 = now_ns();
            for (long i = 0; i < rounds; ++i)
                sink += zlib_reset_once(&zs, body, len, out, sizeof(out));
            snprintf(label, sizeof(label), "zlib q%d: stream kept, deflateReset", quality);
            report(label, now_ns() - t0, rounds, len, out_len);
            deflateEnd(&zs);
        }
    }

    {
        /* The setup alone. Independent of quality: deflateInit2 allocates the window and the
         * hash tables for memLevel 8 whatever the level is. */
        t0 = now_ns();
        for (long i = 0; i < rounds; ++i) {
            z_stream zs;
            memset(&zs, 0, sizeof(zs));
            deflateInit2(&zs, 1, Z_DEFLATED, 31, 8, Z_DEFAULT_STRATEGY);
            sink += (uint64_t)(uintptr_t)zs.state;
            deflateEnd(&zs);
        }
        report("deflateInit2 + deflateEnd, no data", now_ns() - t0, rounds, len, 0);
    }

    printf("  (sink %" PRIu64 ")\n", sink);
}

int main(int argc, char **argv)
{
    static char feed[65536];
    static char post[4096];
    size_t feed_len, post_len;

    if (argc > 1)
        req_per_s = atof(argv[1]);

    feed_len = make_feed(feed, sizeof(feed));
    post_len = (size_t)snprintf(post, sizeof(post), "{\"post\":");
    post_len += (size_t)make_post(post + post_len, sizeof(post) - post_len, 499871, 180);
    post[post_len++] = '}';
    post[post_len] = '\0';

    printf("zlib %s, h2o gzip filter (windowBits 31, memLevel 8); cores at %.0f req/s\n", zlibVersion(),
           req_per_s);

    puts("\n== glibc malloc as it comes ==");
    bench_body("GET /feed, 20 posts", feed, feed_len, FEED_ROUNDS);
    bench_body("GET /posts/:id, one post", post, post_len, POST_ROUNDS);

#ifdef __GLIBC__
    /* The same two bodies once the heap keeps what deflate frees: no trim below 1 GiB, and
     * 16 MB of padding on top, so a stream's 270 KB never leave the process. */
    mallopt(M_TRIM_THRESHOLD, 1 << 30);
    mallopt(M_TOP_PAD, 16 << 20);
    puts("\n== heap trimming off: mallopt(M_TRIM_THRESHOLD, 1 GiB), mallopt(M_TOP_PAD, 16 MB) ==");
    bench_body("GET /feed, 20 posts", feed, feed_len, FEED_ROUNDS);
    bench_body("GET /posts/:id, one post", post, post_len, POST_ROUNDS);
#endif
    return 0;
}
