# CCTV Demo App (React Native Web) — Design

**Date:** 2026-06-03
**Branch:** `feature/cctv-demo-react-native-web` (orphan / blank branch)

## Goal

The same demo CCTV app as `feature/cctv-demo-capacitor`, rebuilt on **Expo (React Native +
react-native-web)** instead of Ionic/Capacitor. Same screens, same mock data, same desktop-first
NVR look — a side-by-side comparison of the two stacks. Fully mocked data and public sample
streams; no backend.

Features (identical to the Ionic build):
- Live footage view per camera (camera wall, all online cameras at once)
- Watch past recordings
- Multiple cameras
- Activity feed per camera with recent detection events

## Stack

- **Expo SDK 56 + react-native-web + TypeScript** — one RN component tree renders to the DOM on
  web today and to native Android/iOS later. Metro web bundler.
- **Video (web):** plain DOM `<video>` rendered inside the RN tree (RNW renders to the DOM).
  `hls.js` for live HLS (native HLS fallback on Safari); direct `<video>` for MP4 recordings.
  These two players are the single web-specific seam to swap for `expo-video` in a native build.
- **Data:** mocked TypeScript modules under `src/data/` — copied verbatim from the Ionic build so
  both apps render identical content.

## Navigation — Expo Router (file-based)

Navigation is **Expo Router** (file-based routing built on React Navigation), so every screen has a
real URL with deep links, refresh, and browser back/forward — and the same routes drive a native
build. The route tree lives in `app/`:

```
app/
  _layout.tsx                  NVR shell (sidebar + header + drawer) wrapping <Slot/>
  index.tsx                    /
  recordings.tsx               /recordings
  events.tsx                   /events
  camera/[cameraId].tsx        /camera/:cameraId
  playback/[recordingId].tsx   /playback/:recordingId
  +not-found.tsx               catch-all
```

The route files are thin wrappers: each reads its params via `useLocalSearchParams` and renders the
matching `src/screens/` component, keeping the screens plain and testable. The shared NVR shell
lives in `app/_layout.tsx` — it derives the header title and active sidebar item from the current
URL (`usePathname` + `useGlobalSearchParams`) and renders the active screen through `<Slot/>`.
Imperative jumps use `useRouter` (`router.push('/camera/' + id)`, `router.replace('/recordings')`,
`router.back()`); the persistent **sidebar** is the primary nav on desktop and a back button
appears on detail/playback routes.

> **Earlier iteration:** the first cut used a hand-rolled in-memory route stack (`NavProvider` with
> a `Route` discriminated union) to avoid React Navigation's web-setup weight. That was fine until
> shareable/refresh-proof URLs became a requirement — at which point Expo Router is the correct
> tool, and it replaced the custom router. The trade is the heavier dependency set
> (`react-native-screens`, `react-native-safe-area-context`, reanimated) for real URLs + native
> parity. See `docs/cctv-demo-stack-comparison.md`.

## Responsive NVR layout

- **Desktop (width ≥ 768):** permanent left sidebar + main area. The camera wall measures its own
  width (`onLayout`) and computes column count from a minimum tile width, reflowing as the window
  resizes. The focus view goes two-column (player left, activity + recordings rail right) at
  width ≥ 1100.
- **Mobile (width < 768):** sidebar collapses; a hamburger opens it as a drawer overlay. Single
  column.

## Data model

Identical to the Ionic build (`CameraStatus`, `DetectionType` string unions; `Camera`,
`DetectionEvent`, `Recording`). State that crosses component boundaries uses string unions, per
project convention — no booleans across boundaries.

## Components

- `LivePlayer` — hls.js wrapper around a DOM `<video>` (handles native HLS on Safari/iOS).
- `VideoPlayer` — MP4 playback for recordings.
- `CameraTile` (wall tile), `EventListItem`, `RecordingListItem`, `CameraFilter`, `Sidebar`.
- `detection` — per-`DetectionType` icon (Ionicons) + color mapping, plus relative-time / clock /
  day formatters.
- `ui` — small shared primitives (Chip, Badge, StatusDot, SectionHeader).

## Testing

Jest (jest-expo):
- **Mock-data integrity** — every event/recording references a valid camera; type unions valid;
  selectors filter to the right camera and order newest-first.
- **`detection` units** — detection metadata mapping and relative-time formatting boundaries
  (just now / min / h / d, future-clamp).

UI streaming/rendering is verified in a real browser rather than in unit tests: `LivePlayer`
renders a DOM `<video>` the native test renderer can't mount, and for a web app live HLS playback
in Chrome is the meaningful proof. Kept light — appropriate for a demo.

## Out of scope (YAGNI)

Real backend, auth, push notifications, native build this pass, real PTZ / timeline scrubbing,
a cross-platform video abstraction.
