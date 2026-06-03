# Export Footage — Design

**Date:** 2026-06-03
**Status:** Approved

## Goal

Let a user export a slice of recorded footage from the playback UI as a downloadable
MP4 file. Reuses the existing P2P playback pipeline; the only new behavior is writing
the decoded stream to a single MP4 file instead of HLS segments.

## Product decisions

- **Range:** Clicking a recording in the existing list prefills start/end; the user can
  edit start/end before exporting (spans across recording-file boundaries allowed).
- **Output:** MP4 stream-copy (`-c:v copy`). Keeps the original HEVC (main 4K / sub
  640×480), near-instant (I/O bound, no transcode, no GPU). File plays in modern
  players (HEVC).
- **Delivery:** Background job. `POST` starts it, UI polls status, a Download button
  appears when the file is ready. Honors the "no HTTP call > 1s" rule.
- **Progress:** Percent of the requested time range — FFmpeg output PTS (`time=` in
  stderr) ÷ requested duration, plus an ETA.
- **Retention:** Auto-delete the MP4 after download, with a 1 h TTL sweep as a backstop.

## Architecture

The export reuses the entire P2P + Hik-RTP front-end. Only the FFmpeg sink differs
(HLS segments → single MP4). To avoid duplicating the ~40 lines of P2P wiring in
`LiveStream`, the video sink becomes pluggable.

```
P2PSession (busType=2, startTime/stopTime)
   → wireDataPath: busType=2 → extractPlaybackPayload (MPEG-PS, -f mpeg)
                   busType=1 → HikRtpExtractor (HEVC NALs, -f hevc)
      → [ VideoSink ]
          ├─ FfmpegHlsPipe   (existing — live + playback view)
          └─ FfmpegMp4Pipe   (new — export, always playback → MPEG-PS)
```

Key fact confirmed in code (`live-stream.ts` `wireDataPath()`): for playback (busType=2)
the data path calls `extractPlaybackPayload()` to strip the 12-byte Hik-RTP header and
writes **MPEG-PS container bytes** to the sink; FFmpeg demuxes with `-f mpeg`. (Live
preview, busType=1, instead runs `HikRtpExtractor` → raw HEVC NALs with `-f hevc`.)
Export is always playback, so the MP4 sink receives MPEG-PS, stream-copies the HEVC
video out of it, and transcodes the audio to AAC (the NVR records G.711 `pcm_alaw`,
which is not a portable MP4 audio codec — a copy would yield an unplayable track):

```
ffmpeg -f mpeg -i pipe:0 -c:v copy -c:a aac -b:a 64k -movflags +faststart out.mp4
```

There is **no explicit end-of-stream event** from `P2PSession`. The NVR streams a
bounded range at ~realtime, then goes quiet. Completion is detected by a data-inactivity
watchdog (no new NALs for ~8 s after streaming started) or by reaching the requested
duration — whichever comes first. The watchdog finalizes the MP4 (`stdin.end()`, wait
for FFmpeg exit so `+faststart` moov atom is written).

## Components

### 1. `VideoSink` interface + `LiveStream` refactor
`src/lib/p2p/live-stream.ts` (and a small shared type)

- Define `VideoSink { start(): void; write(data: Buffer): void; stop(): void }`.
- `FfmpegHlsPipe` already matches this shape — declare it `implements VideoSink`.
- `LiveStream` takes a sink (or sink factory) instead of constructing `FfmpegHlsPipe`
  directly. The P2P/extractor wiring stays identical for both live, playback, and export.
- No back-compat shim — update the existing live/playback callers to pass the HLS sink.

### 2. `FfmpegMp4Pipe`
`src/lib/hls/ffmpeg-mp4-pipe.ts` (sibling of `ffmpeg-pipe.ts`)

- Same pre-buffer-then-spawn behavior as `FfmpegHlsPipe` (buffer ~200 KB so FFmpeg sees
  VPS/SPS/PPS + first IDR before starting).
- Spawns the stream-copy argv above to a known output path.
- Parses stderr for `time=HH:MM:SS.ss` → exposes `progressSeconds` getter.
- `stop()` does a graceful `stdin.end()` and resolves when FFmpeg exits (moov written).
- Pure `buildMp4FfmpegArgs()` function for unit testing, mirroring `buildHlsFfmpegArgs`.

### 3. `ExportJob` registry
`src/app/api/export/jobs.ts` (mirrors `src/app/api/stream/sessions.ts`)

- `globalThis`-pinned `Map<exportId, ExportJob>`.
- `ExportJob`: `{ id, state: 'running'|'done'|'error', stream: LiveStream,
  pipe: FfmpegMp4Pipe, outputPath, requestedDurationSec, error?, watchdog }`.
- Inactivity watchdog (reset on each NAL) finalizes the job; a max-duration cap
  (requestedDuration + small margin) is a hard backstop.
- TTL sweep deletes finished files after 1 h.

### 4. API routes
`src/app/api/export/`

- `POST /start` — body `{deviceSerial, channel, startTime, stopTime}`. Validates range,
  builds the same P2P config as `/api/stream/playback` but with the MP4 sink, registers
  the job, returns `{ exportId }`. Returns quickly (does not wait for completion).
- `GET /[id]/status` — `{ state, percent, sizeBytes, durationSec, error? }`.
  `percent = min(100, progressSeconds / requestedDurationSec * 100)`.
- `GET /[id]/download` — streams the finished MP4 with
  `Content-Disposition: attachment; filename="cam{ch}_{startTime}.mp4"`. 409 if not done.
  Schedules delete after the response completes.

### 5. UI — `ExportPanel`
`src/components/ExportPanel.tsx`, wired into
`src/app/camera/[serial]/[ch]/playback/page.tsx`

- Prefills start/end from the selected recording; both fields editable.
- "Export MP4" button → `POST /start`, then polls `GET /[id]/status` (~1 s).
- Progress bar (percent) + state label; on `done`, a Download button hitting `/download`.
- On `error`, shows the message and a retry.

## Data flow (export)

1. UI `POST /api/export/start` → job created, `LiveStream` started with `FfmpegMp4Pipe`.
2. `P2PSession` (busType=2) streams the range; `HikRtpExtractor` emits HEVC NALs.
3. NALs → `FfmpegMp4Pipe.write()` → FFmpeg stdin → MP4 on disk; each NAL resets watchdog.
4. UI polls `/status`; percent from FFmpeg `time=` vs requested duration.
5. NVR goes quiet → watchdog fires → `pipe.stop()` finalizes MP4 → job `done`.
6. UI shows Download → `GET /download` streams the file → file deleted post-download
   (1 h TTL sweep as backstop).

## Error handling

- **P2P/connect failure:** job → `error`, message surfaced to `/status`; no file.
- **FFmpeg exits non-zero / never starts:** job → `error`; partial file deleted.
- **Zero data (empty range / retention rotated off):** watchdog with no bytes →
  `error: "no footage for this range"`.
- **Download before done:** 409.
- **Server restart:** in-memory jobs lost (acceptable; same model as `sessions`).

## Testing

- Unit: `buildMp4FfmpegArgs()` argv (copy, faststart, `-f hevc`, output path).
- Unit: stderr `time=` parser → `progressSeconds`.
- Unit: `FfmpegMp4Pipe` pre-buffer/spawn + graceful stop, using a fake spawn (mirror
  existing ffmpeg-pipe tests if present).
- Unit: `VideoSink` refactor — `LiveStream` calls the injected sink's start/write/stop.
- Integration script: `scripts/test-export-mp4.ts [start] [stop]` — runs a real export
  against the test NVR, asserts the MP4 is valid HEVC via `ffprobe` (mirrors
  `test-playback-ps.ts`).
- Manual: export from the playback UI; verify progress, download, and playback of the
  resulting MP4.
```
