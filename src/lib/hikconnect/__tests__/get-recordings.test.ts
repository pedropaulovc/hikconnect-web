import { describe, it, expect, vi } from 'vitest'
import { HikConnectClient } from '../client'
import type { Session } from '../types'

const SESSION: Session = {
  sessionId: 'test-session',
  refreshSessionId: 'test-refresh',
  apiDomain: 'apitest.hik-connect.com',
  expiresAt: Date.now() + 3_600_000,
}

/** Build a client whose fetch returns the given upstream JSON body. */
function clientReturning(body: unknown) {
  const fetchFn = vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com', fetch: fetchFn })
  client.setSession(SESSION)
  return { client, fetchFn }
}

describe('getRecordings', () => {
  // The live /v3/streaming/records response nests entries under `records`,
  // each {channelType, begin, end, type} — NOT a `files` array. Reading the
  // wrong key silently returns [] for every device, so the UI never lists any
  // recordings even when the NVR has continuous footage all day.
  const UPSTREAM = {
    meta: { code: 200 },
    records: [
      { channelType: 'D', begin: '2026-06-03T00:27:50', end: '2026-06-03T03:46:55', type: 'TIMING' },
      { channelType: 'D', begin: '2026-06-03T03:46:55', end: '2026-06-03T06:45:38', type: 'TIMING' },
    ],
  }

  it('parses the `records` key from the API response', async () => {
    const { client } = clientReturning(UPSTREAM)
    const files = await client.getRecordings('L38239367', 1, '2026-06-03T00:00:00', '2026-06-03T23:59:59')
    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({ begin: '2026-06-03T00:27:50', end: '2026-06-03T03:46:55', type: 'TIMING' })
  })

  it('returns [] when the device has no recordings', async () => {
    const { client } = clientReturning({ meta: { code: 200 }, records: [] })
    const files = await client.getRecordings('L38239367', 1, '2026-06-03T00:00:00', '2026-06-03T23:59:59')
    expect(files).toEqual([])
  })

  it('queries /v3/streaming/records with the given device, channel and window', async () => {
    const { client, fetchFn } = clientReturning(UPSTREAM)
    await client.getRecordings('L38239367', 2, '2026-06-03T00:00:00', '2026-06-03T23:59:59')
    const calledUrl = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(calledUrl).toContain('/v3/streaming/records')
    expect(calledUrl).toContain('deviceSerial=L38239367')
    expect(calledUrl).toContain('channelNo=2')
    expect(calledUrl).toContain('startTime=2026-06-03T00:00:00')
    expect(calledUrl).toContain('stopTime=2026-06-03T23:59:59')
  })
})
