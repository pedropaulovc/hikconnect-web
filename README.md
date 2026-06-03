# CCTV Demo

A small demo CCTV app built with **Ionic React + Capacitor**. It shows the core surfaces of a
security-camera app — live footage, recordings playback, multiple cameras, and a per-camera
activity feed of detection events.

Everything is **mocked**: cameras, detection events, and recordings are static data, and the
players point at public sample streams (Mux test HLS for "live", Google sample MP4s for
"recordings"). No backend.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
```

Other scripts:

```bash
npm run build      # type-check + production build to dist/
npm run typecheck
npm test           # Vitest unit tests
```

## Screens

- **Live** — grid of cameras; tap one to open its live player plus that camera's **activity
  feed** (recent detections) and recent recordings.
- **Recordings** — past clips grouped by day, filterable by camera; tap to play.
- **Events** — global detection feed across all cameras, filterable by camera; each event links
  to its recording.

## Native (Android) — next step

Capacitor is already configured (`capacitor.config.ts`, `webDir: dist`). To add Android:

```bash
npm run build
npx cap add android
npx cap sync
npx cap open android
```

## Layout

```
src/
  data/         mock cameras, events, recordings + selectors
  components/   LivePlayer (hls.js), VideoPlayer, CameraCard, EventListItem, RecordingListItem
  pages/        Live, CameraDetail, Recordings, Playback, Events
  App.tsx       tab routing
```
