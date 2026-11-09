import * as v from 'valibot'
import { contractValueSchema, loadVectors } from './vectors.ts'

/** The shape of `contracts/test-vectors/announcement.json`: three kinds of vector in one file. */

const hex = v.pipe(v.string(), v.regex(/^([0-9a-f]{2})*$/u))
const hexOf = (bytes: number) =>
  v.pipe(v.string(), v.regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'u')))
const decimal = v.pipe(v.string(), v.regex(/^\d+$/u))

const common = {
  id: v.string(),
  why: v.pipe(v.string(), v.nonEmpty('every vector says what it is load bearing for')),
}

export const announcementVectorSchema = v.variant('kind', [
  v.object({
    ...common,
    kind: v.literal('payload'),
    text: v.nullable(v.string()),
    payload: hex,
    expect: v.object({
      accepted: v.boolean(),
      url: v.nullable(v.string()),
      api: v.nullable(v.array(v.string())),
      announcedAt: v.nullable(decimal),
    }),
  }),
  v.object({
    ...common,
    kind: v.literal('current'),
    announcedAt: decimal,
    nowMs: decimal,
    lastTaken: v.nullable(decimal),
    expect: v.object({ stored: v.boolean() }),
  }),
  v.object({
    ...common,
    kind: v.literal('self-delegation'),
    communitySeed: hexOf(32),
    /** unix milliseconds as a decimal string, 0 for never. */
    expiresMs: decimal,
    expect: v.object({ communityKey: hexOf(32), delegation: hexOf(136) }),
  }),
])

export type AnnouncementVector = v.InferOutput<typeof announcementVectorSchema>

const ruleNames = [
  'maxPayloadBytes',
  'maxApis',
  'apiMaxBytes',
  'urlMaxBytes',
  'maxClockDifferenceSeconds',
] as const

export function loadAnnouncementVectors(): {
  readonly rules: Record<(typeof ruleNames)[number], number>
  readonly vectors: AnnouncementVector[]
} {
  const { file, vectors } = loadVectors('announcement', announcementVectorSchema)
  const parsed = v.parse(
    v.object({
      maxPayloadBytes: contractValueSchema,
      maxApis: contractValueSchema,
      apiMaxBytes: contractValueSchema,
      urlMaxBytes: contractValueSchema,
      maxClockDifferenceSeconds: contractValueSchema,
    }),
    file.rules,
  )
  const rules = Object.fromEntries(
    ruleNames.map((name) => [name, Number(parsed[name].value)]),
  ) as Record<(typeof ruleNames)[number], number>
  return { rules, vectors }
}
