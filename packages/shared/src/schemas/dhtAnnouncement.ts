import * as v from 'valibot'

/**
 * The payload of an announcement on the peer network -- `contracts/types/DhtAnnouncement.json`,
 * held to `contracts/test-vectors/announcement.json`.
 *
 * This is the payload only. The frame around it and the delegation are the node's to check,
 * before anything here is called: by then the community is known, from the delegation, and what
 * is left to decide is whether what it says about itself can be stored.
 *
 * What is stored is called: `url` is where the federation client sends its requests, with an
 * entry of `api` appended. So the schema takes nothing it cannot spell out -- a scheme, a host, a
 * port and a path, each from a short alphabet -- rather than whatever a URL parser would accept.
 * A parser is also what the two paths would disagree in; a grammar they can both be held to.
 */

/** DHT_ANNOUNCE_MAX_PAYLOAD_BYTES in contracts/const.json. */
export const DHT_ANNOUNCE_MAX_PAYLOAD_BYTES = 1024
/** DHT_ANNOUNCE_MAX_APIS in contracts/const.json. */
export const DHT_ANNOUNCE_MAX_APIS = 4
/** DHT_ANNOUNCE_API_MAX_BYTES in contracts/const.json -- `federated_communities.api_version`. */
export const DHT_ANNOUNCE_API_MAX_BYTES = 10
/** DHT_ANNOUNCE_URL_MAX_BYTES in contracts/const.json -- `federated_communities.end_point`. */
export const DHT_ANNOUNCE_URL_MAX_BYTES = 255
/** DHT_ANNOUNCE_MAX_CLOCK_DIFFERENCE_SECONDS in contracts/const.json, in milliseconds. */
export const DHT_ANNOUNCE_MAX_CLOCK_DIFFERENCE_MS = 300_000n

const INT64_MAX = 9223372036854775807n
const HOST_MAX_BYTES = 253
const PORT_MAX = 65535

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const UNESCAPED = '[A-Za-z0-9._~-]'
const SEGMENT = `(?:${UNESCAPED}|%[0-9A-Fa-f]{2})*`
const UNESCAPED_CHAR = new RegExp(`^${UNESCAPED}$`, 'u')
const ESCAPE = /%([0-9A-Fa-f]{2})/gu
const URL = new RegExp(
  `^https?://(?<host>${LABEL}(?:\\.${LABEL})*)(?::(?<port>[1-9][0-9]{0,4}))?(?<path>(?:/${SEGMENT})*)$`,
  'u',
)

/**
 * `scheme://host[:port][/path]`, or empty for a community without a URL.
 *
 * ```text
 * scheme   http or https, lowercase
 * host     a name or a dotted IPv4 address: lowercase labels of letters, digits and inner
 *          hyphens. No IPv6 literal, no trailing dot
 * port     1 to 65535, without leading zeros
 * path     segments of unreserved characters and %XX; none of them `.` or `..`, and no
 *          %XX of an unreserved character -- `%2e%2e` is `..` to a URL parser
 * never    user and password, a query, a fragment
 * ```
 */
export const dhtAnnouncementUrlSchema = v.pipe(
  v.string(),
  v.maxLength(DHT_ANNOUNCE_URL_MAX_BYTES),
  v.check((url) => {
    if (url === '') {
      return true
    }
    const parts = URL.exec(url)?.groups
    if (parts === undefined) {
      return false
    }
    const { host = '', port, path = '' } = parts
    return (
      host.length <= HOST_MAX_BYTES &&
      (port === undefined || Number(port) <= PORT_MAX) &&
      !path.split('/').some((segment) => segment === '.' || segment === '..') &&
      ![...path.matchAll(ESCAPE)].some(([, hex]) =>
        UNESCAPED_CHAR.test(String.fromCharCode(Number.parseInt(hex ?? '', 16))),
      )
    )
  }, 'not a URL an announcement may carry'),
)

/** What the federation client appends to the URL: a name of letters, digits and underscores. */
export const dhtAnnouncementApiSchema = v.pipe(
  v.string(),
  v.regex(new RegExp(`^[A-Za-z0-9_]{1,${DHT_ANNOUNCE_API_MAX_BYTES}}$`, 'u')),
)

const membersSchema = v.pipe(
  v.object({
    url: dhtAnnouncementUrlSchema,
    api: v.pipe(
      v.array(dhtAnnouncementApiSchema),
      v.maxLength(DHT_ANNOUNCE_MAX_APIS),
      v.check((api) => new Set(api).size === api.length, 'an api version is listed twice'),
    ),
    announcedAt: v.pipe(
      v.string(),
      v.regex(/^(0|[1-9][0-9]{0,18})$/u),
      v.transform((text) => BigInt(text)),
      v.maxValue(INT64_MAX),
    ),
  }),
  /* A community without a URL offers no API over HTTP, and one with a URL offers at least one. */
  v.check(
    (payload) => (payload.url === '') === (payload.api.length === 0),
    'url and api are both empty or neither is',
  ),
)

/**
 * The payload from its bytes: size, ASCII, JSON, member names, then the members themselves.
 *
 * The member names are read from the text because JSON.parse cannot tell that one was sent
 * twice -- it keeps the last, where the C path's reader keeps the first. Neither may win, so
 * such a payload is refused, and so is a name spelled with an escape, which could be a second
 * `url` that only one of the two readers recognises.
 */
export const dhtAnnouncementPayloadSchema = v.pipe(
  v.instance(Uint8Array),
  v.check(
    (payload) => payload.length <= DHT_ANNOUNCE_MAX_PAYLOAD_BYTES,
    'the payload is larger than an announcement may be',
  ),
  v.check((payload) => payload.every((byte) => byte < 0x80), 'a byte of the payload is not ASCII'),
  v.rawTransform(({ dataset, addIssue, NEVER }) => {
    const text = Buffer.from(dataset.value).toString('latin1')
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      addIssue({ message: 'the payload is not JSON' })
      return NEVER
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      addIssue({ message: 'the payload is not an object' })
      return NEVER
    }
    const names = memberNames(text)
    if (names === undefined || new Set(names).size !== names.length) {
      addIssue({ message: 'a member is named twice, or with an escape' })
      return NEVER
    }
    return json
  }),
  membersSchema,
)

export type DhtAnnouncement = v.InferOutput<typeof dhtAnnouncementPayloadSchema>

/** What @p payload announces, or undefined when nothing of it may be stored. */
export function parseDhtAnnouncement(payload: Uint8Array): DhtAnnouncement | undefined {
  const parsed = v.safeParse(dhtAnnouncementPayloadSchema, payload)
  return parsed.success ? parsed.output : undefined
}

/** What a node publishes: the same payload, taken through the rules it will be read by. */
export function encodeDhtAnnouncement(announcement: DhtAnnouncement): Uint8Array {
  const payload = new Uint8Array(
    Buffer.from(
      JSON.stringify({
        url: announcement.url,
        api: announcement.api,
        announcedAt: announcement.announcedAt.toString(),
      }),
      'utf8',
    ),
  )
  if (parseDhtAnnouncement(payload) === undefined) {
    throw new Error('this announcement would be refused by every node that receives it')
  }
  return payload
}

/**
 * Whether an announcement made at @p announcedAt is one to store: close enough to this node's
 * clock, and later than the last one taken from that community. That is what keeps an old
 * announcement, signed and valid as it is, from being played back.
 *
 * @p lastTaken is undefined for a community nothing was taken from since this node started.
 */
export function isDhtAnnouncementCurrent(
  announcedAt: bigint,
  nowMs: bigint,
  lastTaken: bigint | undefined,
): boolean {
  const difference = announcedAt > nowMs ? announcedAt - nowMs : nowMs - announcedAt
  if (difference > DHT_ANNOUNCE_MAX_CLOCK_DIFFERENCE_MS) {
    return false
  }
  return lastTaken === undefined || announcedAt > lastTaken
}

/**
 * The member names of the object @p text is, as they are written, or undefined when one of them
 * holds an escape. @p text has been through JSON.parse and is an object: this only has to find
 * the strings that stand where a name stands, not to decide what is JSON.
 */
function memberNames(text: string): string[] | undefined {
  const names: string[] = []
  let depth = 0
  let nameComes = false
  for (let i = 0; i < text.length; ++i) {
    const char = text[i]
    if (char === '"') {
      let end = i + 1
      while (text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1
      }
      if (depth === 1 && nameComes) {
        const name = text.slice(i + 1, end)
        if (name.includes('\\')) {
          return undefined
        }
        names.push(name)
        nameComes = false
      }
      i = end
    } else if (char === '{' || char === '[') {
      depth += 1
      nameComes = depth === 1
    } else if (char === '}' || char === ']') {
      depth -= 1
    } else if (char === ',' && depth === 1) {
      nameComes = true
    }
  }
  return names
}
