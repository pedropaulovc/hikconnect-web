# CCTV Demo (React Native Web)

A small demo CCTV app built with **Expo (React Native + react-native-web)**, **desktop-web first**
(NVR-style console). It shows the core surfaces of a security-camera app — live footage, recordings
playback, multiple cameras, and a per-camera activity feed of detection events.

This is the React Native Web sibling of the Ionic/Capacitor build: the **same screens, same mock
data, and a near-identical look**, rendered through `react-native-web` instead of Ionic. One RN
component tree drives web today and a native Android/iOS build later.

The layout is an NVR console: a persistent **left sidebar** (Cameras / Recordings / Events) and a
main area. On desktop the Cameras page is a **camera wall** — every online camera streams
simultaneously in a responsive grid that reflows to fit the window. It collapses to a single column
with a hamburger drawer on phones (so the planned native build still works).

Routing is **Expo Router** (file-based, built on React Navigation), so every screen has a real URL
— `/`, `/camera/front-door`, `/recordings`, `/playback/rec-003`, `/events`. Deep links, page
refresh, and browser back/forward all work, and the same routes drive a native build.

Everything is **mocked**: cameras, detection events, and recordings are static data, and the
players point at public sample streams (Mux test HLS for "live", Google sample MP4s for
"recordings"). No backend.

## Run

```bash
npm install
npm run web        # opens the Metro web dev server
```

Other scripts:

```bash
npm run typecheck  # tsc --noEmit
npm test           # Jest unit tests (jest-expo)
npm start          # Expo dev server (web / Android / iOS)
```

## Screens

- **Cameras (wall)** — all online cameras streaming at once; offline cameras show an offline
  state. Each tile shows status + last detection. Tap a tile to open the **focus view** (large
  player on the left, that camera's **activity feed** + recent recordings on the right).
- **Recordings** — past clips, filterable by camera; tap to play.
- **Events** — global detection feed across all cameras, filterable by camera.

## Video on web

There is no cross-platform `<Video>` in this demo. On web the players are plain DOM `<video>`
elements rendered inside the RN tree (react-native-web renders to the DOM, so this is allowed):

- **`LivePlayer`** attaches **hls.js** to a `<video>` for the live HLS streams (falling back to the
  browser's native HLS where supported, e.g. Safari).
- **`VideoPlayer`** plays the recording MP4s directly.

For a native build these two components are the seam to swap for `expo-video` (or similar); nothing
else needs to change.

## Native (Android / iOS) — next step

Expo is already configured (`app.json`). To run natively:

```bash
npx expo run:android   # or: npx expo run:ios
```

The only web-specific code is the two players above; swap them for a native video component and the
screens, navigation, and data layer carry over unchanged.

## Layout

```
app/                       Expo Router routes (file-based)
  _layout.tsx              NVR shell: sidebar + header + mobile drawer, wraps <Slot/>
  index.tsx                /                      → CamerasWall
  recordings.tsx           /recordings            → Recordings
  events.tsx               /events                → Events
  camera/[cameraId].tsx    /camera/:id            → CameraDetail (focus)
  playback/[recordingId].tsx  /playback/:id       → Playback
  +not-found.tsx           catch-all
src/
  theme/        colors (dark NVR palette)
  data/         mock cameras, events, recordings + selectors
  components/   Sidebar, CameraTile (wall), LivePlayer (hls.js), VideoPlayer,
                EventListItem, RecordingListItem, CameraFilter, detection (icons/time), ui
  screens/      CamerasWall (wall), CameraDetail (focus), Recordings, Playback, Events
```

The `app/` route files are thin: each reads its URL params (`useLocalSearchParams`) and renders the
matching `src/screens/` component, so the screens stay plain and testable.

## Tests

`npm test` runs the Jest (jest-expo) suite:

- **`src/data/data.test.ts`** — mock-data integrity (referential integrity across cameras /
  events / recordings) and selector behavior (filtering + newest-first ordering).
- **`src/components/detection.test.ts`** — detection metadata mapping and relative-time
  formatting boundaries.

The UI itself (HLS streaming on the wall, focus view, recordings, events, and the mobile drawer) is
verified in a real browser — `LivePlayer` renders a DOM `<video>` that the native test renderer
can't mount, so that surface is covered end-to-end in Chrome rather than in unit tests.
