# CCTV Demo App — Design

**Date:** 2026-06-03
**Branch:** `feature/cctv-demo` (orphan / blank branch)

## Goal

A simple, self-contained demo CCTV web app built with **Ionic React + Capacitor**. It
demonstrates the core surfaces of a security-camera app using fully mocked data and public
sample video streams — no backend.

Features:
- Live footage view (demo video) per camera
- Watch past recordings
- Multiple cameras
- Activity feed per camera with recent detection events

## Stack

- **Ionic React + Vite + TypeScript** — natural fit for the React/TS codebase; Vite static
  build (`dist/`) maps directly to Capacitor's `webDir`.
- **Capacitor** configured now (web-only this pass). App id `com.vezza.cctvdemo`.
  `npx cap add android` later is a one-liner.
- **Video:** `hls.js` for live HLS; native `<video>` for MP4 recordings. Public sample
  streams (Mux test HLS for live, Google sample MP4s for recordings) — nothing bundled.
- **Data:** mocked TypeScript modules under `src/data/`.

## Navigation (Ionic tabs)

| Tab | Page | Contents |
|-----|------|----------|
| **Live** | Camera grid → Camera detail | Grid of camera cards (poster, status, last-event badge). Detail = live HLS player + per-camera **activity feed** + shortcut to that camera's recordings. |
| **Recordings** | Recordings list → Playback | Past recordings grouped by date, filterable by camera; tap → MP4 player. |
| **Events** | Global feed | Recent detection events across all cameras; each links to playback / camera detail. |

## Data model

```ts
type CameraStatus = 'online' | 'offline';
type DetectionType = 'person' | 'vehicle' | 'motion' | 'animal';

interface Camera {
  id: string;
  name: string;
  location: string;
  status: CameraStatus;
  posterUrl: string;
  liveStreamUrl: string; // HLS .m3u8
}

interface DetectionEvent {
  id: string;
  cameraId: string;
  type: DetectionType;
  timestamp: string; // ISO
  thumbnailUrl: string;
  recordingId?: string;
}

interface Recording {
  id: string;
  cameraId: string;
  start: string; // ISO
  end: string;   // ISO
  durationSec: number;
  videoUrl: string; // MP4
  thumbnailUrl: string;
}
```

State that crosses component boundaries uses string unions (`CameraStatus`, `DetectionType`),
per project convention — no booleans across boundaries.

## Components

- `LivePlayer` — hls.js wrapper around `<video>` (handles native HLS on Safari/iOS).
- `VideoPlayer` — MP4 playback for recordings.
- `CameraCard`, `EventListItem`, `RecordingListItem`.
- Per-`DetectionType`: icon + color mapping.

## Testing

Vitest + Testing Library:
- Mock-data integrity (every event/recording references a valid camera; type unions valid).
- `CameraCard` and `EventListItem` render expected text.

Kept light — appropriate for a demo.

## Out of scope (YAGNI)

Real backend, auth, push notifications, native Android build this pass, real PTZ / timeline
scrubbing logic.
