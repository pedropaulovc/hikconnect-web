# Export Footage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Let a user export a recorded footage time-range from the playback UI as a downloadable MP4 file, produced by a background job they can poll for progress.

**Architecture:** Reuse the existing P2P + Hik-RTP playback front-end unchanged. Make the video sink in `LiveStream` pluggable so the same P2P wiring can feed either the existing HLS pipe (live/playback view) or a new MP4 stream-copy pipe (export). A `globalThis`-pinned job registry tracks each export; an inactivity watchdog finalizes the MP4 when the NVR stops streaming the bounded range. New API routes start/poll/download; an `ExportPanel` drives it from the playback page.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Node `child_process` (FFmpeg `-c:v copy`), Vitest. HEVC stream-copy — no GPU/transcode.

---

## Design reference

Full design: `docs/plans/2026-06-03-export-footage-design.md`. Key facts the implementer must trust:

- For **playback** (busType=2) `LiveStream.wireDataPath()` calls `extractPlaybackPayload(payload)` (strips the 12-byte Hik-RTP header) and writes **MPEG-PS container bytes** to the sink; FFmpeg demuxes with `-f mpeg`. (Live preview, busType=1, instead runs `HikRtpExtractor` → raw HEVC NALs with `-f hevc`.) Export is always playback, so the MP4 sink receives **MPEG-PS** and stream-copies the HEVC video out of it: `ffmpeg -f mpeg -i pipe:0 -c:v copy -an -movflags +faststart out.mp4` — the same command proven in `scripts/test-playback-ps.ts`.
- There is **no end-of-stream event** from `P2PSession`. The NVR streams the bounded range at ~realtime then goes quiet. Completion = **data-inactivity watchdog** (no NAL for ~8 s after first byte) OR requested duration reached.
- Times are device wall-clock ISO `YYYY-MM-DDTHH:MM:SS` (no `Z`), as used by `/api/stream/playback`.

## Conventions (match existing code)

- Enums as `const` objects / string unions, not TS `enum`.
- Flat code, early returns, no `else` after return. Buffers are `Buffer`.
- Sinks/registries mirror existing files: `FfmpegHlsPipe` (`src/lib/hls/ffmpeg-pipe.ts`) and `sessions.ts` (`src/app/api/stream/sessions.ts`).
- Tests live in `__tests__/` dirs; run with `npm test -- --run`.

---

### Task 1: `VideoSink` interface + make `LiveStream` sink-pluggable

Refactor so `LiveStream` no longer hardcodes `FfmpegHlsPipe`. The existing live + playback routes keep working by passing an HLS sink.

**Files:**
- Modify: `src/lib/p2p/live-stream.ts`
- Modify: `src/lib/hls/ffmpeg-pipe.ts` (declare `implements VideoSink`)
- Modify callers: `src/app/api/stream/start/route.ts`, `src/app/api/stream/playback/route.ts`
- Test: `src/lib/p2p/__tests__/live-stream-sink.test.ts`

**Step 1: Write the failing test** — `LiveStream` writes extractor output to the injected sink and stops it on `stop()`.

```ts
import { describe, it, expect, vi } from 'vitest'
import { LiveStream } from '../live-stream'
import type { VideoSink } from '../../hls/video-sink'

function fakeSink(): VideoSink & { writes: Buffer[]; started: boolean; stopped: boolean } {
  const s: any = { writes: [], started: false, stopped: false }
  s.start = () => { s.started = true }
  s.write = (b: Buffer) => { s.writes.push(b) }
  s.stop = () => { s.stopped = true }
  return s
}

describe('LiveStream pluggable sink', () => {
  it('starts the injected sink instead of constructing FfmpegHlsPipe', () => {
    const sink = fakeSink()
    const stream = new LiveStream({ /* minimal config */ } as any, () => sink)
    // start() will attempt P2P; we only assert the sink was created+started
    // by stubbing the P2P session — see implementation note below.
    expect(typeof (stream as any).makeSink).toBe('function')
  })
})
```

> Implementation note: the cleanest seam is a constructor second arg `sinkFactory: () => VideoSink`, defaulting to `() => new FfmpegHlsPipe(config.hls)`. Keep the test focused on the seam (factory used, sink.start/stop called) without standing up real P2P — stub `P2PSession.start` via `vi.spyOn` if needed, or assert the factory wiring directly.

**Step 2: Run test, verify it fails**

Run: `npm test -- --run src/lib/p2p/__tests__/live-stream-sink.test.ts`
Expected: FAIL (no `video-sink` module / no factory arg).

**Step 3: Implement**

- Create `src/lib/hls/video-sink.ts`:

```ts
import type { Buffer } from 'node:buffer'

/** A consumer of the decoded HEVC NAL stream. Implemented by HLS + MP4 pipes. */
export type VideoSink = {
  start(): void
  write(data: Buffer): void
  stop(): void
}
```

- In `ffmpeg-pipe.ts`: `export class FfmpegHlsPipe implements VideoSink` (import the type). No behavior change.
- In `live-stream.ts`:
  - Import `VideoSink`.
  - Add constructor param: `constructor(config: LiveStreamConfig, private sinkFactory: (c: LiveStreamConfig) => VideoSink = defaultHlsSinkFactory)`.
  - **Preserve the existing `inputFormat` logic.** Current `start()` computes `const inputFormat = this.config.busType === 2 ? 'mpeg' : 'hevc'` and builds `new FfmpegHlsPipe({ ...this.config.hls, inputFormat })`. Move that into the default factory:
    `const defaultHlsSinkFactory = (c: LiveStreamConfig): VideoSink => new FfmpegHlsPipe({ ...c.hls, inputFormat: c.busType === 2 ? 'mpeg' : 'hevc' })`.
  - Replace the inline pipe construction in `start()` with `this.sink = this.sinkFactory(this.config)`; rename `hlsPipe` field → `sink: VideoSink | null`. Update `wireDataPath()` (writes to `this.sink`), `playlistPath` getter, and `cleanup()` references.
  - `playlistPath` getter: keep, but guard — only HLS sinks have it. Add `get sink()` accessor (returns the sink) so the export route can read MP4 progress. Simplest: expose `getSink(): VideoSink | null`.
- Callers (`start/route.ts`, `playback/route.ts`): no change needed if the factory defaults to HLS. Verify they still compile (they read `stream.playlistPath`).

**Step 4: Run tests**

Run: `npm test -- --run src/lib/p2p` then `npm run typecheck`
Expected: PASS; typecheck clean (ignore the documented `scripts/test-e2e-stream.ts` errors).

**Step 5: Commit**

```bash
git add src/lib/hls/video-sink.ts src/lib/hls/ffmpeg-pipe.ts src/lib/p2p/live-stream.ts src/lib/p2p/__tests__/live-stream-sink.test.ts
git commit -m "refactor: pluggable VideoSink in LiveStream"
```

---

### Task 2: `buildMp4FfmpegArgs` pure function

**Files:**
- Create: `src/lib/hls/ffmpeg-mp4-pipe.ts` (just the pure fn for now)
- Test: `src/lib/hls/__tests__/ffmpeg-mp4-pipe.test.ts`

**Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest'
import { buildMp4FfmpegArgs } from '../ffmpeg-mp4-pipe'

describe('buildMp4FfmpegArgs', () => {
  const OUT = '/tmp/export/cam1.mp4'
  it('stream-copies the HEVC video out of MPEG-PS into MP4 with faststart, no transcode', () => {
    const args = buildMp4FfmpegArgs(OUT)
    expect(args).toContain('copy')                 // -c:v copy
    expect(args).not.toContain('libx264')
    expect(args).not.toContain('h264_nvenc')
    expect(args[args.indexOf('-f') + 1]).toBe('mpeg') // input demuxer = MPEG-PS (playback container)
    expect(args).toContain('+faststart')
    expect(args[args.length - 1]).toBe(OUT)
  })
  it('reads the MPEG-PS stream from stdin and drops audio', () => {
    const args = buildMp4FfmpegArgs(OUT)
    expect(args).toContain('pipe:0')
    expect(args).toContain('-an')
  })
})
```

**Step 2:** Run → FAIL (no module). `npm test -- --run src/lib/hls/__tests__/ffmpeg-mp4-pipe.test.ts`

**Step 3: Implement** (pure fn only)

```ts
import { spawn, ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** FFmpeg argv to remux the playback MPEG-PS stream (stdin) into an MP4 file.
 *  Stream-copy: no re-encode, keeps the native HEVC (main 4K / sub 640×480).
 *  MPEG-PS carries its own PTS, so no synthetic -framerate (unlike the live
 *  raw-hevc path). Matches scripts/test-playback-ps.ts. */
export function buildMp4FfmpegArgs(outputPath: string): string[] {
  return [
    '-probesize', '500000',
    '-analyzeduration', '2000000',
    '-err_detect', 'ignore_err',
    '-f', 'mpeg',
    '-i', 'pipe:0',
    '-c:v', 'copy',
    '-an',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ]
}
```

**Step 4:** Run test → PASS.

**Step 5: Commit**

```bash
git add src/lib/hls/ffmpeg-mp4-pipe.ts src/lib/hls/__tests__/ffmpeg-mp4-pipe.test.ts
git commit -m "feat: buildMp4FfmpegArgs stream-copy argv"
```

---

### Task 3: FFmpeg progress parser

Parse FFmpeg stderr `time=HH:MM:SS.ss` → seconds, for percent-of-range progress.

**Files:**
- Modify: `src/lib/hls/ffmpeg-mp4-pipe.ts` (add `parseFfmpegProgressSeconds`)
- Test: `src/lib/hls/__tests__/ffmpeg-mp4-pipe.test.ts` (extend)

**Step 1: Failing test**

```ts
import { parseFfmpegProgressSeconds } from '../ffmpeg-mp4-pipe'

describe('parseFfmpegProgressSeconds', () => {
  it('parses time= from an ffmpeg progress line', () => {
    const line = 'frame= 250 fps=25 q=-1.0 size=2048kB time=00:01:23.50 bitrate=...'
    expect(parseFfmpegProgressSeconds(line)).toBeCloseTo(83.5, 1)
  })
  it('returns null when no time= present', () => {
    expect(parseFfmpegProgressSeconds('Press [q] to stop')).toBeNull()
  })
  it('handles hours', () => {
    expect(parseFfmpegProgressSeconds('time=01:00:00.00')).toBeCloseTo(3600, 1)
  })
})
```

**Step 2:** Run → FAIL.

**Step 3: Implement**

```ts
const TIME_RE = /time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/

/** Extract the current output position (seconds) from an ffmpeg stderr line. */
export function parseFfmpegProgressSeconds(line: string): number | null {
  const m = TIME_RE.exec(line)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}
```

**Step 4:** Run → PASS.

**Step 5: Commit**

```bash
git add src/lib/hls/ffmpeg-mp4-pipe.ts src/lib/hls/__tests__/ffmpeg-mp4-pipe.test.ts
git commit -m "feat: parse ffmpeg progress time"
```

---

### Task 4: `FfmpegMp4Pipe` class (VideoSink)

Mirror `FfmpegHlsPipe`: pre-buffer ~200 KB, spawn, expose `progressSeconds`, graceful `stop()` that resolves when FFmpeg exits (so the `+faststart` moov atom is written).

**Files:**
- Modify: `src/lib/hls/ffmpeg-mp4-pipe.ts`
- Test: `src/lib/hls/__tests__/ffmpeg-mp4-pipe.test.ts` (extend)

**Step 1: Failing test** (construction/buffering, no real ffmpeg)

```ts
import { FfmpegMp4Pipe } from '../ffmpeg-mp4-pipe'

describe('FfmpegMp4Pipe', () => {
  it('exposes the output path', () => {
    const pipe = new FfmpegMp4Pipe({ outputPath: '/tmp/export/x.mp4' })
    expect(pipe.getOutputPath()).toBe('/tmp/export/x.mp4')
  })
  it('buffers before ffmpeg starts and starts progress at 0', () => {
    const pipe = new FfmpegMp4Pipe({ outputPath: '/tmp/export/x.mp4' })
    pipe.start()
    expect(() => pipe.write(Buffer.from('test'))).not.toThrow()
    expect(pipe.progressSeconds).toBe(0)
  })
  it('implements VideoSink (start/write/stop)', () => {
    const pipe = new FfmpegMp4Pipe({ outputPath: '/tmp/export/x.mp4' })
    expect(typeof pipe.start).toBe('function')
    expect(typeof pipe.write).toBe('function')
    expect(typeof pipe.stop).toBe('function')
  })
})
```

**Step 2:** Run → FAIL.

**Step 3: Implement** `FfmpegMp4Pipe` (copy structure from `FfmpegHlsPipe`):

- `constructor(private config: { outputPath: string })` → `mkdirSync(dirname(outputPath), {recursive:true})` in `start()`.
- Same pre-buffer (200 KB) gate before `spawn('ffmpeg', buildMp4FfmpegArgs(outputPath), {stdio:['pipe','pipe','pipe']})`.
- `stderr` handler: `const s = parseFfmpegProgressSeconds(line); if (s !== null) this._progress = s` (also `console.log('[ffmpeg-mp4]', line)`).
- `get progressSeconds()` → `this._progress` (init 0).
- Swallow `stdin` EPIPE like the HLS pipe.
- `stop(): Promise<void>` → `stdin.end()`, then `await once(process, 'close')` (use `node:events.once`); if no process, resolve immediately. SIGTERM as a fallback after a short timeout so a hung ffmpeg can't block forever.
- `implements VideoSink` — note `VideoSink.stop()` returns `void`; `Promise<void>` is assignable. Keep the `VideoSink` type's `stop(): void | Promise<void>` if TS complains (update the interface + `FfmpegHlsPipe` no-op stays `void`).

**Step 4:** Run → PASS; `npm run typecheck`.

**Step 5: Commit**

```bash
git add src/lib/hls/ffmpeg-mp4-pipe.ts src/lib/hls/__tests__/ffmpeg-mp4-pipe.test.ts src/lib/hls/video-sink.ts
git commit -m "feat: FfmpegMp4Pipe export sink"
```

---

### Task 5: Export job registry + helpers

A `globalThis`-pinned registry (mirror `sessions.ts`) plus pure helpers for percent and filename.

**Files:**
- Create: `src/app/api/export/jobs.ts`
- Create: `src/app/api/export/export-helpers.ts`
- Test: `src/app/api/export/__tests__/export-helpers.test.ts`

**Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest'
import { exportPercent, exportFilename, durationSeconds } from '../export-helpers'

describe('export helpers', () => {
  it('durationSeconds from ISO range', () => {
    expect(durationSeconds('2026-06-03T14:00:00', '2026-06-03T14:05:00')).toBe(300)
  })
  it('percent clamps to 100 and floors at 0', () => {
    expect(exportPercent(150, 300)).toBe(50)
    expect(exportPercent(600, 300)).toBe(100)
    expect(exportPercent(0, 0)).toBe(0)            // guard divide-by-zero
  })
  it('filename is safe and descriptive', () => {
    expect(exportFilename(1, '2026-06-03T14:00:00'))
      .toBe('cam1_2026-06-03_140000.mp4')
  })
})
```

**Step 2:** Run → FAIL.

**Step 3: Implement**

`export-helpers.ts`:

```ts
export function durationSeconds(startTime: string, stopTime: string): number {
  return Math.max(0, (Date.parse(stopTime) - Date.parse(startTime)) / 1000)
}

export function exportPercent(progressSec: number, totalSec: number): number {
  if (totalSec <= 0) return 0
  return Math.min(100, Math.floor((progressSec / totalSec) * 100))
}

export function exportFilename(channel: number, startTime: string): string {
  const stamp = startTime.replace('T', '_').replace(/:/g, '')
  return `cam${channel}_${stamp}.mp4`
}
```

`jobs.ts` (mirror `sessions.ts`):

```ts
import type { LiveStream } from '@/lib/p2p/live-stream'
import type { FfmpegMp4Pipe } from '@/lib/hls/ffmpeg-mp4-pipe'

export const EXPORT_STATES = ['running', 'done', 'error'] as const
export type ExportState = typeof EXPORT_STATES[number]

export type ExportJob = {
  id: string
  state: ExportState
  stream: LiveStream
  pipe: FfmpegMp4Pipe
  outputPath: string
  filename: string
  requestedDurationSec: number
  error?: string
}

const g = globalThis as unknown as { __hikExportJobs?: Map<string, ExportJob> }
export const exportJobs = (g.__hikExportJobs ??= new Map<string, ExportJob>())

/** Inactivity before we consider a bounded playback finished (ms). */
export const EXPORT_IDLE_FINALIZE_MS = 8_000
/** Delete finished export files after this long as a backstop (ms). */
export const EXPORT_TTL_MS = 60 * 60 * 1000
```

**Step 4:** Run → PASS.

**Step 5: Commit**

```bash
git add src/app/api/export/jobs.ts src/app/api/export/export-helpers.ts src/app/api/export/__tests__/export-helpers.test.ts
git commit -m "feat: export job registry + helpers"
```

---

### Task 6: `POST /api/export/start`

Start an export job: same P2P config as `/api/stream/playback`, but inject the MP4 sink and wire the inactivity watchdog.

**Files:**
- Create: `src/app/api/export/start/route.ts`

> No new unit test — this route is thin glue over already-tested pieces; it's covered by the integration script (Task 10) + manual QA. (Existing playback route has no unit test either.)

**Step 1: Implement** (adapt `playback/route.ts`):

- Parse `{ deviceSerial, channel = 1, startTime, stopTime }`; validate all present (400 otherwise).
- `const exportId = \`ex-${deviceSerial}-${channel}-${Date.now()}\``.
- `const outputPath = join(tmpdir(), 'exports', exportId, exportFilename(channel, startTime))`.
- Build the same `LiveStream` config as playback (`busType: 2`, `streamType: 0`, start/stop time, P2P secret/config). The `hls` field is still required by the type — pass a throwaway `{ outputDir: dirname(outputPath) }`; the MP4 sink ignores it.
- `const pipe = new FfmpegMp4Pipe({ outputPath })`.
- `const stream = new LiveStream(config, () => pipe)`.
- Register job `{ state: 'running', requestedDurationSec: durationSeconds(startTime, stopTime), ... }`.
- **Watchdog:** keep a `lastData = Date.now()` updated on a `'data'` cue. Cleanest: have `LiveStream` already emit via the sink — but the sink is internal. Instead, attach to the P2P data indirectly: add a tiny hook. Simplest reliable approach — poll in an interval:

```ts
const finalize = async (state: ExportState, error?: string) => {
  clearInterval(timer)
  await stream.stop()              // stops P2P + pipe (pipe.stop awaits ffmpeg exit)
  const job = exportJobs.get(exportId)
  if (job) { job.state = state; if (error) job.error = error }
}
const startedAt = Date.now()
const timer = setInterval(() => {
  const progressed = pipe.progressSeconds > 0
  const idleMs = /* see note */ 0
  // Finish when ffmpeg has output >= requested duration (with 2s margin)…
  if (progressed && pipe.progressSeconds >= requestedDurationSec - 2) finalize('done')
  // …or hard cap: wall time exceeded requested duration + 15s and some data seen
  if (progressed && Date.now() - startedAt > (requestedDurationSec + 15) * 1000) finalize('done')
  // …or no data at all after 12s → error
  if (!progressed && Date.now() - startedAt > 12_000) finalize('error', 'no footage for this range')
}, 1000)
```

> Watchdog rationale: `progressSeconds` (FFmpeg output PTS) is a reliable activity signal that needs no new event plumbing. When it reaches the requested duration we're done; if it never moves, the range is empty. This avoids adding a NAL-level inactivity hook through the sink boundary. If a true byte-level idle signal is later wanted, add an optional `onData` callback to `LiveStream` — not needed for v1.

- Also wire `stream.on('error', e => finalize('error', e.message))` and `stream.on('stateChange', ...)` to catch P2P errors.
- `await stream.start()` then return `{ exportId }`. On throw: cleanup job, 500.

**Step 2: Verify** `npm run typecheck` clean.

**Step 3: Commit**

```bash
git add src/app/api/export/start/route.ts
git commit -m "feat: POST /api/export/start"
```

---

### Task 7: `GET /api/export/[id]/status`

**Files:**
- Create: `src/app/api/export/[id]/status/route.ts`

**Step 1: Implement**

```ts
import { NextResponse } from 'next/server'
import { statSync } from 'node:fs'
import { exportJobs } from '../../jobs'
import { exportPercent } from '../../export-helpers'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const job = exportJobs.get(id)
  if (!job) return NextResponse.json({ error: 'not found' }, { status: 404 })

  let sizeBytes = 0
  try { sizeBytes = statSync(job.outputPath).size } catch {}

  return NextResponse.json({
    state: job.state,
    percent: job.state === 'done' ? 100 : exportPercent(job.pipe.progressSeconds, job.requestedDurationSec),
    sizeBytes,
    durationSec: job.requestedDurationSec,
    filename: job.filename,
    error: job.error,
  })
}
```

**Step 2:** `npm run typecheck`.

**Step 3: Commit**

```bash
git add "src/app/api/export/[id]/status/route.ts"
git commit -m "feat: GET /api/export/[id]/status"
```

---

### Task 8: `GET /api/export/[id]/download`

Stream the finished MP4 as an attachment; delete after the response, with TTL backstop.

**Files:**
- Create: `src/app/api/export/[id]/download/route.ts`

**Step 1: Implement**

- 404 if no job; 409 if `job.state !== 'done'`.
- Read the file as a stream (`createReadStream`) and return it in a `Response` with headers:
  - `Content-Type: video/mp4`
  - `Content-Disposition: attachment; filename="${job.filename}"`
  - `Content-Length: statSync(...).size`
- After streaming (`stream.on('close')`), `rmSync(dirname(outputPath), {recursive:true, force:true})` and `exportJobs.delete(id)`.
- TTL backstop: in `jobs.ts` add a lazy sweeper invoked here — or `setTimeout(EXPORT_TTL_MS)` scheduled in the start route on `done`. Keep v1 simple: schedule the TTL delete in Task 6's `finalize('done')` via `setTimeout`.

> Next.js note: return a `web` `ReadableStream`. Convert the Node read stream with `Readable.toWeb(createReadStream(path))` and pass to `new Response(webStream, { headers })`.

**Step 2:** `npm run typecheck`; sanity-run dev server and hit the route after a manual export (deferred to QA).

**Step 3: Commit**

```bash
git add "src/app/api/export/[id]/download/route.ts" src/app/api/export/jobs.ts
git commit -m "feat: GET /api/export/[id]/download + cleanup"
```

---

### Task 9: `ExportPanel` UI + wire into playback page

**Files:**
- Create: `src/components/ExportPanel.tsx`
- Create: `src/components/ExportPanel.module.css` (mirror existing component styling)
- Modify: `src/app/camera/[serial]/[ch]/playback/page.tsx`
- Test: `src/components/__tests__/export-panel-helpers.test.ts` (if any pure helper is extracted; otherwise rely on manual QA — the existing UI components have no unit tests)

**Step 1: Implement `ExportPanel`**

Props: `{ serial: string; channel: number; defaultStart: string; defaultStop: string }`.

State (string-union, per conventions): `exportState: 'idle' | 'starting' | 'exporting' | 'done' | 'error'`, `start`, `stop`, `exportId`, `percent`, `filename`, `error`.

Behavior:
- Two `datetime-local` inputs bound to `start`/`stop`, prefilled from props (convert ISO `YYYY-MM-DDTHH:MM:SS` ↔ the `datetime-local` value).
- "Export MP4" button → `POST /api/export/start` with `{deviceSerial, channel, startTime, stopTime}` (convert inputs back to server ISO with the existing `datetimeLocalToServer` helper in `src/app/camera/alarm-helpers.ts`). Set `exportId`, go `exporting`.
- While `exporting`: poll `GET /api/export/${exportId}/status` every 1 s (`setInterval` in `useEffect`, cleared on unmount/state change). Update `percent`. On `state==='done'` → `done`; on `'error'` → `error` with message.
- `done`: render a Download link `href={\`/api/export/${exportId}/download\`}` (anchor with `download`).
- Progress bar = simple `<div>` width `${percent}%`.

**Step 2: Wire into playback page**

- When `activeRecording` (or a selected recording) exists, render `<ExportPanel serial={serial} channel={Number(ch)} defaultStart={activeRecording.begin} defaultStop={activeRecording.end} />`. Also allow exporting without playing — show the panel whenever `recordings.length > 0`, defaulting to the first/most-recent recording's range, since the user can edit the fields.

**Step 3:** `npm run typecheck`; `npm run build` to ensure the client compiles.

**Step 4: Commit**

```bash
git add src/components/ExportPanel.tsx src/components/ExportPanel.module.css "src/app/camera/[serial]/[ch]/playback/page.tsx"
git commit -m "feat: export footage UI panel"
```

---

### Task 10: Integration script + final verification

Real export against the test NVR, validated with `ffprobe` (mirror `scripts/test-playback-ps.ts`).

**Files:**
- Create: `scripts/test-export-mp4.ts`

**Step 1: Implement** a script that:
- Logs in via `getAuthenticatedClient` (same bootstrap as `test-playback-ps.ts`).
- Builds the export `LiveStream` + `FfmpegMp4Pipe` directly (no HTTP), for a recent ~20 s range (args `[start] [stop]`, default to a recent time like the playback test).
- Runs until the watchdog finalizes, then `ffprobe`s the output MP4 and asserts: container=mov/mp4, codec=hevc, duration ≈ requested (±20%), nonzero size. Prints PASS/FAIL.

**Step 2: Run it**

Run: `npx tsx scripts/test-export-mp4.ts`
Expected: prints the saved MP4 path and `PASS` with `codec=hevc`, plausible duration. (Recording retention rotates old footage off — if it reports "no footage", pass a recent timestamp via args.)

**Step 3: Full regression**

Run: `npm test -- --run` (expect all prior tests still pass + new ones) and `npm run typecheck`.

**Step 4: Manual UI QA**

`npm run dev` → open a camera's playback page → load recordings → adjust export range → Export → watch progress to 100% → Download → confirm the MP4 plays.

**Step 5: Commit**

```bash
git add scripts/test-export-mp4.ts
git commit -m "test: export mp4 integration script"
```

---

## Done criteria

- All unit tests pass; typecheck clean.
- `scripts/test-export-mp4.ts` produces a valid HEVC MP4 of the requested range.
- From the UI: select range → background export → progress bar → download a playable MP4.
- Finished export files are deleted after download (TTL backstop in place).
