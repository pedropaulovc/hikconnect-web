# CCTV Demo

A small demo CCTV app built with **Ionic React + Capacitor**, **desktop-web first** (NVR-style
console). It shows the core surfaces of a security-camera app — live footage, recordings
playback, multiple cameras, and a per-camera activity feed of detection events.

The layout is an NVR console: a persistent **left sidebar** (Cameras / Recordings / Events) and a
main area. On desktop the Cameras page is a **camera wall** — every online camera streams
simultaneously in a responsive grid. It collapses to a single column with a hamburger drawer on
phones (so the planned Android build still works).

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

- **Cameras (wall)** — all online cameras streaming at once; offline cameras show an offline
  state. Each tile shows status + last detection. Click a tile to open the **focus view** (large
  player on the left, that camera's **activity feed** + recent recordings on the right).
- **Recordings** — past clips grouped by day, filterable by camera; click to play.
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
  components/   SideMenu, CameraTile (wall), LivePlayer (hls.js), VideoPlayer,
                EventListItem, RecordingListItem
  pages/        Live (wall), CameraDetail (focus), Recordings, Playback, Events
  App.tsx       IonSplitPane sidebar + routing
```
