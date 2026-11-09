import { describe, expect, test } from 'bun:test'
import { signDhtDelegation } from '@gradido/shared/crypto'
import {
  DHT_ANNOUNCE_API_MAX_BYTES,
  DHT_ANNOUNCE_MAX_APIS,
  DHT_ANNOUNCE_MAX_CLOCK_DIFFERENCE_MS,
  DHT_ANNOUNCE_MAX_PAYLOAD_BYTES,
  DHT_ANNOUNCE_URL_MAX_BYTES,
  isDhtAnnouncementCurrent,
  parseDhtAnnouncement,
} from '@gradido/shared/schemas'
import { loadAnnouncementVectors } from './announcement.vectors.ts'

/**
 * `contracts/test-vectors/announcement.json`, run against the TypeScript path.
 *
 * There is no other half yet: the fast path parses no announcement payload so far, and
 * `fast-servers/tests/contract/test_announcement_contract.cpp` comes with the code that does.
 * The self-delegations are signed by `node:crypto` here; the file's values were signed and
 * verified by libp2p-ffi itself.
 */

const { rules, vectors } = loadAnnouncementVectors()
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'))
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')

describe('contract vectors: announcement', () => {
  test('the bounds are the ones the file was written against', () => {
    expect(DHT_ANNOUNCE_MAX_PAYLOAD_BYTES).toBe(rules.maxPayloadBytes)
    expect(DHT_ANNOUNCE_MAX_APIS).toBe(rules.maxApis)
    expect(DHT_ANNOUNCE_API_MAX_BYTES).toBe(rules.apiMaxBytes)
    expect(DHT_ANNOUNCE_URL_MAX_BYTES).toBe(rules.urlMaxBytes)
    expect(DHT_ANNOUNCE_MAX_CLOCK_DIFFERENCE_MS).toBe(
      BigInt(rules.maxClockDifferenceSeconds) * 1000n,
    )
  })

  for (const vector of vectors) {
    test(vector.id, () => {
      switch (vector.kind) {
        case 'payload': {
          if (vector.text !== null) {
            expect(Buffer.from(vector.text, 'utf8').toString('hex')).toBe(vector.payload)
          }
          /* A vector may not disagree with itself: taken names every value, refused names none. */
          const { accepted, url, api, announcedAt } = vector.expect
          expect([url, api, announcedAt].every((value) => (value !== null) === accepted)).toBe(true)

          const announcement = parseDhtAnnouncement(bytes(vector.payload))
          expect(announcement !== undefined).toBe(accepted)
          if (announcement !== undefined) {
            const taken: typeof vector.expect = {
              accepted: true,
              url: announcement.url,
              api: announcement.api,
              announcedAt: announcement.announcedAt.toString(),
            }
            expect(taken).toEqual(vector.expect)
          }
          break
        }
        case 'current': {
          const lastTaken = vector.lastTaken === null ? undefined : BigInt(vector.lastTaken)
          expect(
            isDhtAnnouncementCurrent(BigInt(vector.announcedAt), BigInt(vector.nowMs), lastTaken),
          ).toBe(vector.expect.stored)
          break
        }
        case 'self-delegation': {
          const communityKey = bytes(vector.expect.communityKey)
          const privateKey = bytes(vector.communitySeed + vector.expect.communityKey)
          const delegation = signDhtDelegation(privateKey, communityKey, BigInt(vector.expiresMs))
          expect(hex(delegation)).toBe(vector.expect.delegation)
          break
        }
      }
    })
  }
})
