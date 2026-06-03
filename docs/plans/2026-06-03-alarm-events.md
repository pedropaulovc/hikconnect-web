# Per-Camera Alarm Events Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** List a camera's alarm/motion events with a time-range filter, thumbnails, load-more pagination, and click-to-playback, surfaced as a panel on the existing playback page.

**Architecture:** A `getAlarms` client method wraps the device-wide `/v3/alarms/advanced` endpoint. A pure `collectChannelAlarms` accumulator filters the device stream by `channelNo` across pages (the endpoint has no channel param). A thin `/api/devices/[serial]/[channel]/alarms` route exposes `{events, nextOffset, hasMore}`. The playback page gains an events panel that loads ranges, paginates via the cursor, and on click drives the existing `VideoPlayer` at the event's timestamp.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Vitest (`environment: 'node'` — tests are pure logic/helpers, never React renders), existing HikConnect REST client + P2P/HLS playback backend.

---

## Design reference

Full design + RE findings: `docs/plans/2026-06-03-alarm-events-design.md`. Read it first.

### Verified real API response (captured live 2026-06-03 via `scripts/probe-alarms.ts`)

`GET /v3/alarms/advanced?limit=50&queryType=-1&alarmType=-1&deviceSerial=L38239367&alarmStart=2026-05-27 13:00:00&alarmEnd=2026-06-03 13:00:00&offset=0`

```jsonc
// top level
{ "meta": { "code": 200, "message": "操作成功", "moreInfo": null },
  "page": { "offset": 0, "limit": 50, "totalResults": 100, "hasNext": true },
  "alarms": [ /* ... */ ] }

// alarms[0] — full real object
{
  "alarmId": "MPY2ZMV37PU_28LVXO96X_L38239367_5",
  "userId": null,
  "deviceSerial": "L38239367",
  "channelNo": 5,
  "channelType": 1,
  "alarmName": "Bikes",
  "startTime": null,
  "alarmType": 10002,
  "alarmStartTime": 1780492040319,          // epoch ms (UTC)
  "alarmStartTimeStr": "2026-06-03 13:07:20", // device wall-clock, "yyyy-MM-dd HH:mm:ss"
  "checkSum": null,
  "isCheck": 0,                              // 0 = unread
  "isVideo": 0,
  "isEncrypt": 0,                            // 0 = picUrl directly fetchable
  "isCloud": 0,
  "picUrl": "https://apiius.ezvizlife.com/v3/unifiedmsg/business/message/pic/get?fileId=...&sign=...",
  "recUrl": "",
  "s_picUrl": null, "s_recUrl": null, "remark": null, "recState": 0, "relationId": null,
  "picUrlGroup": "https://apiius.ezvizlife.com/.../pic/get?...&isEncrypted=0&...",
  "sampleName": "Motion Detection Alarm",
  "preTime": 5,                              // seconds before the event
  "delayTime": 25,                           // seconds after the event
  "customerType": null, "customerInfo": null, "withTinyVideo": 0,
  "relationAlarm": null, "relationAlarms": null,
  "alarmMessage": "Bikes Motion Detection Alarm",
  "crypt": 0, "analysisType": 0, "analysisResult": null,
  "hasValueAddedService": false, "showHumanName": null
}
```

### Two verified behaviors that shape the code (do NOT re-derive — they are non-obvious)

1. **`page.totalResults` is unreliable.** It returns a placeholder `100` on the first page (`offset=0`) and the true count (`12228`) only once `offset ≥ limit`. **Never drive pagination/UI off `totalResults` — use `page.hasNext`.**
2. **`offset` is page-quantized to `limit`.** The server floors a requested offset to `floor(offset/limit)*limit` and echoes the snapped value as `page.offset` (e.g. `offset=95, limit=50` returns the same page as `offset=50`). **Keep `limit` fixed and advance the cursor as `page.offset + limit`** so it stays page-aligned (no gap/overlap). Deep pagination works (offset=1000 → prior day); not capped at 100.

### Verified playback time format (from `src/lib/p2p/p2p-session.ts:484`)

Playback `startTime`/`stopTime` are `YYYY-MM-DDTHH:MM:SS` (device wall-clock, `T` separator, **no** timezone). The alarm filter API instead wants `yyyy-MM-dd HH:mm:ss` (space separator). The event→window helper converts between them.

---

## Task 1: Alarm types

**Files:**
- Modify: `src/lib/hikconnect/types.ts` (append after `RecordListResponse`, ~line 125)

**Step 1: Add the types**

Append to `src/lib/hikconnect/types.ts`:

```ts
/** A single alarm/motion event from /v3/alarms/advanced */
export type AlarmEvent = {
  alarmId: string
  channelNo: number
  alarmName: string          // "Bikes"
  alarmType: number          // 10002
  sampleName: string         // "Motion Detection Alarm"
  alarmMessage: string       // "Bikes Motion Detection Alarm"
  alarmStartTime: number     // epoch ms (UTC)
  alarmStartTimeStr: string  // "2026-06-03 13:07:20" (device wall-clock)
  picUrl: string             // signed thumbnail; directly fetchable when isEncrypt=0
  isCheck: number            // 0 = unread
  isEncrypt: number          // 0 for this account
  preTime: number            // seconds before event
  delayTime: number          // seconds after event
}

/** Pagination block on /v3/alarms/advanced. NOTE: totalResults is unreliable — use hasNext. */
export type AlarmPage = {
  offset: number
  limit: number
  totalResults: number
  hasNext: boolean
}

/** GET /v3/alarms/advanced response */
export type AlarmListResponse = ApiResponse<{
  alarms: AlarmEvent[]
  page: AlarmPage
}>
```

**Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: no new errors.

**Step 3: Commit**

```bash
git add src/lib/hikconnect/types.ts
git commit -m "feat: add alarm event types"
```

---

## Task 2: `client.getAlarms`

**Files:**
- Modify: `src/lib/hikconnect/client.ts` (add import; add method after `getRecordings`, ~line 184)
- Test: `src/lib/hikconnect/client.test.ts`

**Step 1: Write the failing test**

Add to `src/lib/hikconnect/client.test.ts` inside the top-level `describe('HikConnectClient', ...)`:

```ts
  describe('getAlarms', () => {
    const sessionInit = { sessionId: 'sess123', refreshSessionId: 'rf456', apiDomain: 'https://api.hik-connect.com', expiresAt: Date.now() + 3600000 }

    it('builds the advanced-alarms query and returns alarms + page', async () => {
      const mockFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({
          meta: { code: 200, message: 'OK' },
          page: { offset: 0, limit: 50, totalResults: 100, hasNext: true },
          alarms: [{ alarmId: 'a1', channelNo: 5, alarmMessage: 'Bikes Motion Detection Alarm' }],
        }), { status: 200 })
      )
      const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com', fetch: mockFetch as unknown as typeof fetch })
      client.setSession(sessionInit)

      const result = await client.getAlarms('L38239367', {
        alarmStart: '2026-06-03 00:00:00', alarmEnd: '2026-06-03 13:00:00', offset: 0, limit: 50,
      })

      expect(result.alarms).toHaveLength(1)
      expect(result.alarms[0].channelNo).toBe(5)
      expect(result.page.hasNext).toBe(true)

      const url = new URL(mockFetch.mock.lastCall![0] as string)
      expect(url.pathname).toBe('/v3/alarms/advanced')
      expect(url.searchParams.get('deviceSerial')).toBe('L38239367')
      expect(url.searchParams.get('queryType')).toBe('-1')
      expect(url.searchParams.get('alarmType')).toBe('-1')
      expect(url.searchParams.get('limit')).toBe('50')
      expect(url.searchParams.get('offset')).toBe('0')
      expect(url.searchParams.get('alarmStart')).toBe('2026-06-03 00:00:00')
      expect(url.searchParams.get('alarmEnd')).toBe('2026-06-03 13:00:00')
    })

    it('throws when meta.code is not 200', async () => {
      const mockFetch = vi.fn(async () =>
        new Response(JSON.stringify({ meta: { code: 99991, message: 'session expired' } }), { status: 200 })
      )
      const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com', fetch: mockFetch as unknown as typeof fetch })
      client.setSession(sessionInit)
      await expect(client.getAlarms('L38239367', { alarmStart: 'x', alarmEnd: 'y' })).rejects.toThrow('session expired')
    })

    it('defaults offset=0 and limit=50 when omitted', async () => {
      const mockFetch = vi.fn(async () =>
        new Response(JSON.stringify({ meta: { code: 200, message: 'OK' }, page: { offset: 0, limit: 50, totalResults: 0, hasNext: false }, alarms: [] }), { status: 200 })
      )
      const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com', fetch: mockFetch as unknown as typeof fetch })
      client.setSession(sessionInit)
      await client.getAlarms('L38239367', { alarmStart: 'a', alarmEnd: 'b' })
      const url = new URL(mockFetch.mock.lastCall![0] as string)
      expect(url.searchParams.get('offset')).toBe('0')
      expect(url.searchParams.get('limit')).toBe('50')
    })
  })
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/hikconnect/client.test.ts -t getAlarms`
Expected: FAIL — `client.getAlarms is not a function`.

**Step 3: Implement the method**

In `src/lib/hikconnect/client.ts`, add to the type import block (lines 3-10):

```ts
  AlarmEvent, AlarmPage, AlarmListResponse,
```

Add the method after `getRecordings` (after ~line 184):

```ts
  async getAlarms(
    deviceSerial: string,
    opts: { alarmStart: string; alarmEnd: string; offset?: number; limit?: number },
  ): Promise<{ alarms: AlarmEvent[]; page: AlarmPage }> {
    const qs = new URLSearchParams({
      limit: String(opts.limit ?? 50),
      queryType: '-1',
      alarmType: '-1',
      deviceSerial,
      alarmStart: opts.alarmStart,
      alarmEnd: opts.alarmEnd,
      offset: String(opts.offset ?? 0),
    })
    const data = await this.get<AlarmListResponse>(`/v3/alarms/advanced?${qs.toString()}`)
    return { alarms: data.alarms ?? [], page: data.page }
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/hikconnect/client.test.ts -t getAlarms`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add src/lib/hikconnect/client.ts src/lib/hikconnect/client.test.ts
git commit -m "feat: add getAlarms client method"
```

---

## Task 3: `collectChannelAlarms` accumulator (pure)

The device endpoint mixes channels, so we accumulate channel matches across device pages. Pure (takes a `fetchPage` callback) so it unit-tests without network.

**Files:**
- Create: `src/lib/hikconnect/alarms.ts`
- Test: `src/lib/hikconnect/alarms.test.ts`

**Step 1: Write the failing test**

Create `src/lib/hikconnect/alarms.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { collectChannelAlarms } from './alarms'
import type { AlarmEvent, AlarmPage } from './types'

// Minimal alarm factory — only channelNo matters for filtering.
const ev = (channelNo: number, alarmId = `${channelNo}`): AlarmEvent => ({
  alarmId, channelNo, alarmName: '', alarmType: 0, sampleName: '', alarmMessage: '',
  alarmStartTime: 0, alarmStartTimeStr: '', picUrl: '', isCheck: 0, isEncrypt: 0, preTime: 0, delayTime: 0,
})
const page = (offset: number, hasNext: boolean): AlarmPage => ({ offset, limit: 50, totalResults: 100, hasNext })

describe('collectChannelAlarms', () => {
  it('filters a single device page by channelNo', async () => {
    const fetchPage = vi.fn(async (offset: number) => ({ alarms: [ev(1), ev(5), ev(1), ev(7)], page: page(offset, false) }))
    const r = await collectChannelAlarms(fetchPage, 1, 0, 15, { devicePage: 50, maxPages: 4 })
    expect(r.events.map(e => e.channelNo)).toEqual([1, 1])
    expect(r.hasMore).toBe(false)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('accumulates across pages until want is reached', async () => {
    const fetchPage = vi.fn(async (offset: number) => ({
      alarms: [ev(1), ev(5), ev(1)],            // 2 channel-1 matches per page
      page: page(offset, true),
    }))
    const r = await collectChannelAlarms(fetchPage, 1, 0, 3, { devicePage: 50, maxPages: 4 })
    expect(r.events).toHaveLength(4)            // scanned 2 pages (2 + 2 >= want=3)
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(r.nextOffset).toBe(100)             // 0 -> page.offset(50)+50
    expect(r.hasMore).toBe(true)
  })

  it('stops at maxPages for a sparse channel and reports hasMore', async () => {
    const fetchPage = vi.fn(async (offset: number) => ({ alarms: [ev(9)], page: page(offset, true) }))
    const r = await collectChannelAlarms(fetchPage, 1, 0, 15, { devicePage: 50, maxPages: 3 })
    expect(r.events).toHaveLength(0)
    expect(fetchPage).toHaveBeenCalledTimes(3)
    expect(r.hasMore).toBe(true)
    expect(r.nextOffset).toBe(150)
  })

  it('stops when the device reports no more pages', async () => {
    const fetchPage = vi.fn(async (offset: number) => ({ alarms: [ev(1)], page: page(offset, false) }))
    const r = await collectChannelAlarms(fetchPage, 1, 0, 15, { devicePage: 50, maxPages: 4 })
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(r.hasMore).toBe(false)
  })

  it('advances the cursor from the snapped page.offset (offset quantization)', async () => {
    // Server snaps requested offset 95 down to 50.
    const fetchPage = vi.fn(async (_requested: number) => ({ alarms: [ev(1)], page: page(50, true) }))
    const r = await collectChannelAlarms(fetchPage, 1, 95, 1, { devicePage: 50, maxPages: 4 })
    expect(r.nextOffset).toBe(100)             // snapped 50 + devicePage 50
  })

  it('starts from the given offset', async () => {
    const fetchPage = vi.fn(async (offset: number) => ({ alarms: [ev(1)], page: page(offset, false) }))
    await collectChannelAlarms(fetchPage, 1, 200, 15, { devicePage: 50, maxPages: 4 })
    expect(fetchPage).toHaveBeenCalledWith(200)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/hikconnect/alarms.test.ts`
Expected: FAIL — cannot find `./alarms`.

**Step 3: Implement**

Create `src/lib/hikconnect/alarms.ts`:

```ts
import type { AlarmEvent, AlarmPage } from './types'

export type AlarmPageResult = { alarms: AlarmEvent[]; page: AlarmPage }
export type ChannelAlarms = { events: AlarmEvent[]; nextOffset: number; hasMore: boolean }

/**
 * Accumulate alarms for one channel from the device-wide /v3/alarms/advanced stream.
 *
 * The endpoint has no channel param and offset is page-quantized to `limit`, so we pull
 * device pages, filter by channelNo, and advance the cursor as page.offset + devicePage
 * (page-aligned, snap-proof). Stops at >= want matches, when the device has no more pages,
 * or after maxPages (bounds latency for sparse channels). Pure: takes a fetchPage callback.
 */
export async function collectChannelAlarms(
  fetchPage: (offset: number) => Promise<AlarmPageResult>,
  channelNo: number,
  startOffset: number,
  want: number,
  opts: { devicePage: number; maxPages: number },
): Promise<ChannelAlarms> {
  const events: AlarmEvent[] = []
  let offset = startOffset
  let hasMore = false

  for (let i = 0; i < opts.maxPages; i++) {
    const { alarms, page } = await fetchPage(offset)
    events.push(...alarms.filter(a => a.channelNo === channelNo))
    offset = page.offset + opts.devicePage

    if (!page.hasNext) {
      hasMore = false
      break
    }
    hasMore = true
    if (events.length >= want) break
  }

  return { events, nextOffset: offset, hasMore }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/hikconnect/alarms.test.ts`
Expected: PASS (6 tests).

**Step 5: Commit**

```bash
git add src/lib/hikconnect/alarms.ts src/lib/hikconnect/alarms.test.ts
git commit -m "feat: add per-channel alarm accumulator"
```

---

## Task 4: Alarms API route

**Files:**
- Create: `src/app/api/devices/[serial]/[channel]/alarms/route.ts`
- Test: `src/app/api/devices/[serial]/[channel]/alarms/__tests__/route.test.ts`

**Step 1: Write the failing test**

This is the codebase's first API-route test. It mocks `getAuthenticatedClient` (which reads a session singleton) to return a fake client exposing `getAlarms`.

Create `src/app/api/devices/[serial]/[channel]/alarms/__tests__/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AlarmPageResult } from '@/lib/hikconnect/alarms'

const getAlarms = vi.fn()
vi.mock('@/lib/hikconnect/getClient', () => ({
  getAuthenticatedClient: () => ({ getAlarms }),
}))

import { GET } from '../route'

const params = (serial: string, channel: string) => ({ params: Promise.resolve({ serial, channel }) })

beforeEach(() => { getAlarms.mockReset() })

describe('GET /api/devices/[serial]/[channel]/alarms', () => {
  it('400s when the time range is missing', async () => {
    const res = await GET(new Request('http://x/api?offset=0'), params('L38239367', '1'))
    expect(res.status).toBe(400)
  })

  it('filters by channel and returns events + cursor', async () => {
    const result: AlarmPageResult = {
      alarms: [
        { alarmId: 'a', channelNo: 1, alarmName: '', alarmType: 0, sampleName: '', alarmMessage: '', alarmStartTime: 0, alarmStartTimeStr: '', picUrl: '', isCheck: 0, isEncrypt: 0, preTime: 0, delayTime: 0 },
        { alarmId: 'b', channelNo: 5, alarmName: '', alarmType: 0, sampleName: '', alarmMessage: '', alarmStartTime: 0, alarmStartTimeStr: '', picUrl: '', isCheck: 0, isEncrypt: 0, preTime: 0, delayTime: 0 },
      ],
      page: { offset: 0, limit: 50, totalResults: 100, hasNext: false },
    }
    getAlarms.mockResolvedValue(result)
    const url = 'http://x/api?alarmStart=2026-06-03 00:00:00&alarmEnd=2026-06-03 13:00:00&offset=0&limit=15'
    const res = await GET(new Request(url), params('L38239367', '1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.events).toHaveLength(1)
    expect(body.events[0].channelNo).toBe(1)
    expect(body.hasMore).toBe(false)
    expect(typeof body.nextOffset).toBe('number')
    // forwards the device serial + time range to the client
    expect(getAlarms).toHaveBeenCalledWith('L38239367', expect.objectContaining({
      alarmStart: '2026-06-03 00:00:00', alarmEnd: '2026-06-03 13:00:00', limit: 50,
    }))
  })

  it('500s when the client throws', async () => {
    getAlarms.mockRejectedValue(new Error('boom'))
    const url = 'http://x/api?alarmStart=a&alarmEnd=b'
    const res = await GET(new Request(url), params('L38239367', '1'))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('boom')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/api/devices/[serial]/[channel]/alarms/__tests__/route.test.ts"`
Expected: FAIL — cannot find `../route`.

**Step 3: Implement the route**

Create `src/app/api/devices/[serial]/[channel]/alarms/route.ts`:

```ts
// src/app/api/devices/[serial]/[channel]/alarms/route.ts
import { NextResponse } from 'next/server'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'
import { collectChannelAlarms } from '@/lib/hikconnect/alarms'

const DEVICE_PAGE = 50
const MAX_PAGES = 4

export async function GET(req: Request, { params }: { params: Promise<{ serial: string; channel: string }> }) {
  try {
    const { serial, channel } = await params
    const url = new URL(req.url)
    const alarmStart = url.searchParams.get('alarmStart') ?? ''
    const alarmEnd = url.searchParams.get('alarmEnd') ?? ''
    if (!alarmStart || !alarmEnd) {
      return NextResponse.json({ error: 'alarmStart and alarmEnd required' }, { status: 400 })
    }
    const offset = Number(url.searchParams.get('offset') ?? '0')
    const want = Number(url.searchParams.get('limit') ?? '15')

    const client = getAuthenticatedClient()
    const result = await collectChannelAlarms(
      (o) => client.getAlarms(serial, { alarmStart, alarmEnd, offset: o, limit: DEVICE_PAGE }),
      Number(channel), offset, want, { devicePage: DEVICE_PAGE, maxPages: MAX_PAGES },
    )
    return NextResponse.json(result)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/api/devices/[serial]/[channel]/alarms/__tests__/route.test.ts"`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add "src/app/api/devices/[serial]/[channel]/alarms"
git commit -m "feat: add per-camera alarms API route"
```

---

## Task 5: Alarm UI helpers (time formatting, event→window, state, URL)

Pure helpers, unit-tested. Datetime-local inputs are browser wall-clock; the filter API wants `yyyy-MM-dd HH:mm:ss`; playback wants `YYYY-MM-DDTHH:MM:SS`.

**Files:**
- Create: `src/app/camera/alarm-helpers.ts`
- Modify: `src/app/camera/stream-states.ts` (add alarm panel state union)
- Modify: `src/app/devices/helpers.ts` (add `buildAlarmsUrl`)
- Test: `src/app/camera/__tests__/alarm-helpers.test.ts`
- Test: `src/app/devices/__tests__/devices-logic.test.ts` (add `buildAlarmsUrl` case)

**Step 1: Write the failing tests**

Create `src/app/camera/__tests__/alarm-helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { datetimeLocalToServer, defaultAlarmRange, eventToPlaybackWindow } from '../alarm-helpers'

describe('datetimeLocalToServer', () => {
  it('converts datetime-local to "yyyy-MM-dd HH:mm:ss"', () => {
    expect(datetimeLocalToServer('2026-06-03T13:07')).toBe('2026-06-03 13:07:00')
  })
  it('keeps seconds when present', () => {
    expect(datetimeLocalToServer('2026-06-03T13:07:42')).toBe('2026-06-03 13:07:42')
  })
})

describe('defaultAlarmRange', () => {
  it('returns a 24h window ending at now, as datetime-local strings', () => {
    const now = new Date('2026-06-03T13:00:00') // local
    const { from, to } = defaultAlarmRange(now)
    expect(to).toBe('2026-06-03T13:00')
    expect(from).toBe('2026-06-02T13:00')
  })
})

describe('eventToPlaybackWindow', () => {
  it('builds [start-preTime, start+delayTime] in playback format (T separator, no tz)', () => {
    const w = eventToPlaybackWindow({ alarmStartTimeStr: '2026-06-03 13:07:20', preTime: 5, delayTime: 25 })
    expect(w.begin).toBe('2026-06-03T13:07:15')
    expect(w.end).toBe('2026-06-03T13:07:45')
  })
  it('handles minute/hour rollover across the offsets', () => {
    const w = eventToPlaybackWindow({ alarmStartTimeStr: '2026-06-03 13:59:58', preTime: 0, delayTime: 5 })
    expect(w.end).toBe('2026-06-03T14:00:03')
  })
})
```

Add to `src/app/devices/__tests__/devices-logic.test.ts` (inside the existing top-level describe):

```ts
  describe('buildAlarmsUrl', () => {
    it('encodes serial, channel, time range, and offset', () => {
      const url = buildAlarmsUrl('L38239367', 1, '2026-06-03 00:00:00', '2026-06-03 13:00:00', 50)
      const parsed = new URL(url, 'http://x')
      expect(parsed.pathname).toBe('/api/devices/L38239367/1/alarms')
      expect(parsed.searchParams.get('alarmStart')).toBe('2026-06-03 00:00:00')
      expect(parsed.searchParams.get('alarmEnd')).toBe('2026-06-03 13:00:00')
      expect(parsed.searchParams.get('offset')).toBe('50')
    })
  })
```

Ensure the test file imports `buildAlarmsUrl` from `../helpers` (extend the existing import line).

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/camera/__tests__/alarm-helpers.test.ts src/app/devices/__tests__/devices-logic.test.ts`
Expected: FAIL — missing module / `buildAlarmsUrl` not exported.

**Step 3: Implement**

Create `src/app/camera/alarm-helpers.ts`:

```ts
/** datetime-local value ("YYYY-MM-DDTHH:mm[:ss]") -> filter API format "yyyy-MM-dd HH:mm:ss". */
export function datetimeLocalToServer(local: string): string {
  const withSeconds = local.length === 16 ? `${local}:00` : local
  return withSeconds.replace('T', ' ')
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Format local wall-clock components as a datetime-local input value (no seconds). */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Default filter window: last 24h ending at `now`, as datetime-local input values. */
export function defaultAlarmRange(now: Date): { from: string; to: string } {
  const from = new Date(now.getTime() - 24 * 3600 * 1000)
  return { from: toLocalInput(from), to: toLocalInput(now) }
}

/**
 * Build a playback window around an alarm in playback format "YYYY-MM-DDTHH:MM:SS"
 * (device wall-clock, no timezone). We parse alarmStartTimeStr as UTC and format UTC
 * components so the arithmetic never drifts by the runner's local timezone.
 */
export function eventToPlaybackWindow(
  event: { alarmStartTimeStr: string; preTime: number; delayTime: number },
): { begin: string; end: string } {
  const base = Date.parse(`${event.alarmStartTimeStr.replace(' ', 'T')}Z`)
  const fmt = (ms: number) => {
    const d = new Date(ms)
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  }
  return {
    begin: fmt(base - (event.preTime ?? 0) * 1000),
    end: fmt(base + (event.delayTime ?? 0) * 1000),
  }
}
```

Add to `src/app/camera/stream-states.ts`:

```ts
export const ALARM_PANEL_STATES = ['idle', 'loading', 'loaded', 'error'] as const
export type AlarmPanelState = typeof ALARM_PANEL_STATES[number]
```

Add to `src/app/devices/helpers.ts`:

```ts
export function buildAlarmsUrl(serial: string, ch: number, alarmStart: string, alarmEnd: string, offset: number): string {
  const qs = new URLSearchParams({ alarmStart, alarmEnd, offset: String(offset) })
  return `/api/devices/${serial}/${ch}/alarms?${qs.toString()}`
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/camera/__tests__/alarm-helpers.test.ts src/app/devices/__tests__/devices-logic.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/app/camera/alarm-helpers.ts src/app/camera/__tests__/alarm-helpers.test.ts src/app/camera/stream-states.ts src/app/devices/helpers.ts src/app/devices/__tests__/devices-logic.test.ts
git commit -m "feat: add alarm UI helpers (time format, playback window, url, state)"
```

---

## Task 6: Events panel on the playback page

Wire the panel into the existing playback page. No unit test (React render — the codebase runs in node env and does not render components); verified by `npm run typecheck`, `npm run build`, and the e2e check in Task 7. All logic it relies on is already tested in Tasks 2-5.

**Files:**
- Modify: `src/app/camera/[serial]/[ch]/playback/page.tsx`
- Modify: `src/app/camera/[serial]/[ch]/playback/page.module.css`

**Step 1: Add types + state + handlers**

In `playback/page.tsx`:

1. Extend imports:

```ts
import { buildRecordingsUrl, buildAlarmsUrl } from '@/app/devices/helpers'
import { datetimeLocalToServer, defaultAlarmRange, eventToPlaybackWindow } from '@/app/camera/alarm-helpers'
import type { AlarmPanelState } from '@/app/camera/stream-states'
import type { AlarmEvent } from '@/lib/hikconnect/types'
```

2. Add state inside the component (alongside the existing playback state):

```ts
  const [range, setRange] = useState(() => defaultAlarmRange(new Date()))
  const [events, setEvents] = useState<AlarmEvent[]>([])
  const [alarmState, setAlarmState] = useState<AlarmPanelState>('idle')
  const [nextOffset, setNextOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
```

3. Add a loader (append mode for "Load More"):

```ts
  const loadEvents = async (offset: number, append: boolean) => {
    setAlarmState('loading')
    try {
      const url = buildAlarmsUrl(
        serial, Number(ch),
        datetimeLocalToServer(range.from), datetimeLocalToServer(range.to),
        offset,
      )
      const res = await fetch(url)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setEvents(prev => append ? [...prev, ...data.events] : data.events)
      setNextOffset(data.nextOffset)
      setHasMore(data.hasMore)
      setAlarmState('loaded')
    } catch {
      setAlarmState('error')
    }
  }
```

4. Click → playback (reuses the existing playback flow on this page):

```ts
  const playEvent = (event: AlarmEvent) => {
    const window = eventToPlaybackWindow(event)
    playRecording({ begin: window.begin, end: window.end })
  }
```

(`Recording` is `{ begin: string; end: string }` — `playRecording` POSTs `startTime: rec.begin, stopTime: rec.end` to `/api/stream/playback`. The window is in the device's `YYYY-MM-DDTHH:MM:SS` playback format, the same format the existing recordings flow uses.)

**Step 2: Add the panel JSX**

Below the recordings list (before the closing `</div>` of `.container`), add an events panel:

```tsx
        <div className={styles.eventsPanel}>
          <h3 className={styles.eventsTitle}>Events</h3>
          <div className={styles.eventsRange}>
            <input type="datetime-local" value={range.from}
              onChange={e => setRange(r => ({ ...r, from: e.target.value }))} className={styles.dateInput} />
            <span>→</span>
            <input type="datetime-local" value={range.to}
              onChange={e => setRange(r => ({ ...r, to: e.target.value }))} className={styles.dateInput} />
            <button onClick={() => loadEvents(0, false)} disabled={alarmState === 'loading'} className={styles.loadButton}>
              {alarmState === 'loading' ? 'Loading...' : 'Load Events'}
            </button>
          </div>

          {alarmState === 'error' && <p className={styles.error}>Failed to load events</p>}
          {alarmState === 'loaded' && events.length === 0 && <p className={styles.noRecordings}>No events in range</p>}

          <div className={styles.eventsList}>
            {events.map(ev => (
              <div key={ev.alarmId} className={styles.eventItem} onClick={() => playEvent(ev)}>
                {ev.isEncrypt === 0 && ev.picUrl
                  ? <img src={ev.picUrl} alt="" className={styles.eventThumb} loading="lazy" />
                  : <div className={styles.eventThumbPlaceholder} />}
                <div className={styles.eventMeta}>
                  <span className={styles.eventName}>
                    {ev.isCheck === 0 && <span className={styles.unreadDot} />}
                    {ev.alarmMessage}
                  </span>
                  <span className={styles.eventTime}>{ev.alarmStartTimeStr}</span>
                </div>
              </div>
            ))}
          </div>

          {hasMore && (
            <button onClick={() => loadEvents(nextOffset, true)} disabled={alarmState === 'loading'} className={styles.loadButton}>
              {alarmState === 'loading' ? 'Loading...' : 'Load More'}
            </button>
          )}
        </div>
```

**Step 3: Add CSS**

Append to `playback/page.module.css` (match the existing dark theme — reuse colors from the file):

```css
.eventsPanel { margin-top: 1.5rem; }
.eventsTitle { font-size: 1rem; margin-bottom: 0.5rem; color: #e0e0e0; }
.eventsRange { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
.eventsList { display: flex; flex-direction: column; gap: 0.25rem; max-height: 420px; overflow-y: auto; }
.eventItem { display: flex; gap: 0.75rem; align-items: center; padding: 0.5rem; border-radius: 6px; cursor: pointer; background: #1a1a1a; }
.eventItem:hover { background: #262626; }
.eventThumb { width: 96px; height: 54px; object-fit: cover; border-radius: 4px; background: #000; flex-shrink: 0; }
.eventThumbPlaceholder { width: 96px; height: 54px; border-radius: 4px; background: #000; flex-shrink: 0; }
.eventMeta { display: flex; flex-direction: column; gap: 0.15rem; }
.eventName { display: flex; align-items: center; gap: 0.4rem; color: #e0e0e0; }
.eventTime { font-size: 0.8rem; color: #888; }
.unreadDot { width: 8px; height: 8px; border-radius: 50%; background: #6cb4ee; display: inline-block; }
```

**Step 4: Typecheck + build**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run build`
Expected: build succeeds.

**Step 5: Commit**

```bash
git add "src/app/camera/[serial]/[ch]/playback"
git commit -m "feat: events panel with thumbnails, load-more, click-to-playback"
```

---

## Task 7: Docs, e2e smoke, cleanup, full suite

**Files:**
- Modify: `CLAUDE.md` (Commands / Protocol Testing — mention the alarms probe)
- Modify: `docs/re/api-notes.md` (document `/v3/alarms/advanced`)
- Keep: `scripts/probe-alarms.ts` (reusable diagnostic, mirrors `probe-recordings.ts`)
- Delete: `scripts/probe-alarms-depth.ts` (one-off investigation)
- Optional e2e: `e2e/` (only if an alarms e2e fits the existing harness; otherwise skip)

**Step 1: Live smoke test against the real device**

Run: `npx tsx scripts/probe-alarms.ts`
Expected: `meta.code 200`, a `page` block, ≥1 alarm with the documented fields. Confirms the route's upstream call still works credentials-only.

**Step 2: Document the endpoint**

Add a short section to `docs/re/api-notes.md` describing `GET /v3/alarms/advanced` (params, the two gotchas: unreliable `totalResults`, page-quantized `offset`), and note per-camera filtering is client-side on `channelNo`. Add the alarms probe to the Protocol Testing list in `CLAUDE.md`.

**Step 3: Remove the one-off probe**

```bash
git rm -f scripts/probe-alarms-depth.ts 2>/dev/null || rm -f scripts/probe-alarms-depth.ts
```

**Step 4: Full suite + typecheck + lint**

Run: `npm test -- --run`
Expected: all pass (existing 239 + the new alarm tests).

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint` (if present)
Expected: clean.

**Step 5: Commit**

```bash
git add CLAUDE.md docs/re/api-notes.md scripts/probe-alarms.ts
git commit -m "docs: document /v3/alarms/advanced; add alarms probe script"
```

---

## Done criteria

- `getAlarms` + `collectChannelAlarms` + route + helpers all green under Vitest.
- Playback page shows an events panel: time-range filter (default last 24h), thumbnails, unread dots, Load More, click → playback at the event's time.
- `npm test -- --run`, `npm run typecheck`, `npm run build` all pass.
- Live `scripts/probe-alarms.ts` returns real events credentials-only.

## Out of scope (YAGNI)

- Alarm-type filter (per scoping decision).
- Encrypted-thumbnail decryption (account is `isEncrypt=0`).
- Marking events read/unread, deleting events (`/api/message/alarms/*` exist but unrequested).
- Timezone reconciliation between browser and device — uses local wall-clock to match the app's `SimpleDateFormat`; documented caveat.
