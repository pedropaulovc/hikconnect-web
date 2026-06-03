# Per-Camera Alarm Events — Design

**Goal:** List a camera's alarm/motion events (like the Hik-Connect app), with a time-range
filter, thumbnails, pagination/load-more, and click-to-playback. Surface them as a panel on
the existing playback page.

**Status:** Design approved 2026-06-03. Next step: implementation plan (writing-plans).

---

## Endpoint (reverse-engineered + verified live)

The app's history list calls a **device-wide** alarm endpoint (jadx: `wb6.java`, defaults from
`lda.java` — `limit=15, queryType=-1, alarmType=-1, offset=0`):

```
GET /v3/alarms/advanced
    ?limit={n}&queryType=-1&alarmType=-1
    &deviceSerial={serial}
    &alarmStart={yyyy-MM-dd HH:mm:ss}&alarmEnd={yyyy-MM-dd HH:mm:ss}
    &offset={n}
```

Response:

```jsonc
{
  "meta": { "code": 200, "message": "..." },
  "alarms": [ { /* see AlarmEvent */ } ],
  "page": { "offset": 0, "limit": 15, "totalResults": 12255, "hasNext": true }
}
```

**Verified live (2026-06-03):** offset pagination returns distinct sets; `alarmStart`/`alarmEnd`
window narrows results; `totalResults` reflects the window. Each alarm carries `channelNo`,
`alarmName` (`"Lobby"`), `alarmType` (`10002`), `sampleName` (`"Motion Detection Alarm"`),
`alarmMessage` (`"Lobby Motion Detection Alarm"`), `alarmStartTime` (epoch ms),
`alarmStartTimeStr` (`"2026-06-03 11:49:17"`), `picUrl` (signed ezvizlife.com thumbnail,
directly fetchable when `isEncrypt=0`), `isCheck` (read/unread), `preTime`, `delayTime`.

**Why not `/v3/alarms/v2/advanced`:** that endpoint ignores offset/time filters — always returns
the latest ~100. **Why not `/v3/unifiedmsg/list`:** newer endTime-cursor variant; `advanced`
matches the app's history screen and is simpler to paginate by offset.

**Key constraint:** the endpoint has **no channel parameter** — it is device-wide. Per-camera is
a `channelNo` filter we apply over the device stream.

---

## Architecture

```
playback page  ──GET──▶  /api/devices/[serial]/[ch]/alarms
                              │
                              ▼
                    collectChannelAlarms()  (pure)
                              │  fetchPage(offset)
                              ▼
                    client.getAlarms()  ──▶  /v3/alarms/advanced
```

### 1. Types — `src/lib/hikconnect/types.ts`

```ts
export type AlarmEvent = {
  alarmId: string
  channelNo: number
  alarmName: string          // "Lobby"
  alarmType: number          // 10002
  sampleName: string         // "Motion Detection Alarm"
  alarmMessage: string       // "Lobby Motion Detection Alarm"
  alarmStartTime: number     // epoch ms
  alarmStartTimeStr: string  // "2026-06-03 11:49:17"
  picUrl: string             // signed thumbnail
  isCheck: number            // 0 = unread
  isEncrypt: number          // 0 for this account
  preTime: number
  delayTime: number
}

export type AlarmPage = { offset: number; limit: number; totalResults: number; hasNext: boolean }
export type AlarmListResponse = ApiResponse<{ alarms: AlarmEvent[]; page: AlarmPage }>
```

### 2. Client method — `src/lib/hikconnect/client.ts`

`getAlarms(deviceSerial, { alarmStart, alarmEnd, offset = 0, limit = 50 })` → `{ alarms, page }`,
built like `getRecordings` via the existing `get<T>()` (which already validates `meta.code`).
Fixed query params `queryType=-1`, `alarmType=-1`.

### 3. Per-camera accumulation — `src/lib/hikconnect/alarms.ts` (pure)

The device endpoint mixes channels, so the route accumulates channel matches across device pages:

```ts
export async function collectChannelAlarms(
  fetchPage: (offset: number) => Promise<{ alarms: AlarmEvent[]; page: AlarmPage }>,
  channelNo: number,
  startOffset: number,
  want: number,
  opts: { devicePage: number; maxPages: number },
): Promise<{ events: AlarmEvent[]; nextOffset: number; hasMore: boolean }>
```

Pull a device page, filter by `channelNo`, accumulate; stop at ≥`want` matches, `!hasNext`, or
`maxPages` (cap). `nextOffset` = device offset after the last scanned page (clean load-more
resume); `hasMore` reflects whether more device pages remain. Sequential with early-exit — a
50-event device page usually yields enough for one channel in 1 RTT; `maxPages=4` bounds the
worst case. Pure (takes a `fetchPage` callback) so it unit-tests without network.

### 4. Route — `src/app/api/devices/[serial]/[channel]/alarms/route.ts`

Thin wrapper (like `recordings/route.ts`): read `alarmStart`/`alarmEnd` (400 if missing),
`offset` (default 0), `limit` (default 15). Call `collectChannelAlarms` with
`(o) => client.getAlarms(serial, { alarmStart, alarmEnd, offset: o, limit: 50 })`,
`devicePage: 50, maxPages: 4`. Return `{ events, nextOffset, hasMore }`. try/catch → 500.

### 5. UI — panel on the playback page

`src/app/camera/[serial]/[ch]/playback/page.tsx` gains an events panel beside the date/recordings
UI:

- **Time range:** two `datetime-local` inputs (from/to), default last 24h, formatted to
  `yyyy-MM-dd HH:mm:ss`. "Load Events" button.
- **List:** `<img src={picUrl}>` thumbnail + `alarmMessage` + `alarmStartTimeStr` + unread dot
  (`isCheck === 0`).
- **Load More:** shown while `hasMore`, passes `nextOffset`.
- **Click → jump to playback:** reuse the page's existing playback flow. Build a window
  `[alarmStartTime − preTime, alarmStartTime + clip]` and drive the same `VideoPlayer`. No
  cross-page navigation — the panel already lives on the playback page.
- **State:** an events union in `stream-states.ts` (`'idle' | 'loading' | 'loaded' | 'error'`).
- **Helpers:** datetime-local ↔ `yyyy-MM-dd HH:mm:ss` and event→playback-window construction in
  `helpers.ts`.

---

## Error handling

- Client throws on `meta.code !== 200` (existing `get<T>()`).
- Route: 400 on missing time range; 500 `{error}` on failure.
- UI: error text + empty state ("No events in range").

## Testing

- `client.test.ts`: `getAlarms` builds the right URL/params/encoding, parses `{alarms, page}`,
  throws on `meta` error.
- `alarms.test.ts`: `collectChannelAlarms` — channel filter, multi-page accumulate, `maxPages`
  cap, `hasMore`/`nextOffset`, early-exit at `want`, stop on `!hasNext`. Pure, mocked `fetchPage`.
- route test: 400 on missing range, param passthrough, `{events, nextOffset, hasMore}` shape.
- helpers: datetime-format round-trips, event→window construction.
- UI: events state-machine transitions.

## Scope boundaries (YAGNI)

- **No alarm-type filter** — per scoping decision.
- **No encrypted-thumbnail decryption** — account is `isEncrypt=0`; defer until a device needs it.
- **Timezone:** local wall-clock, matching the app's default `SimpleDateFormat` (verified accepted
  live); no UTC conversion.
