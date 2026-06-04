# CCTV Demo — Ionic/Capacitor vs React Native Web

Two branches build the **same** desktop-first NVR demo (camera wall, focus view, recordings,
events, per-camera activity) from the **same mock data**, on two different stacks. This doc maps
what's shared, what diverges, and why.

| | `feature/cctv-demo-capacitor` | `feature/cctv-demo-react-native-web` |
|---|---|---|
| UI framework | Ionic React 8 | React Native + react-native-web (Expo SDK 56) |
| Build / dev server | Vite 6 | Metro (via Expo) |
| Language | TypeScript 5.7 | TypeScript 6.0 (strict) |
| Routing | `@ionic/react-router` + `react-router` 5 (URL routes) | Expo Router (file-based, URL routes) |
| Layout primitives | Ionic components + CSS files | RN `View`/`Text`/`Pressable` + `StyleSheet` |
| Styling | CSS + Ionic CSS variables (`theme/variables.css`) | JS `StyleSheet` objects + a `colors` module |
| Icons | `ionicons` (web components) | `@expo/vector-icons` (Ionicons set) |
| Live video | hls.js → DOM `<video>` | hls.js → DOM `<video>` (**identical**) |
| Recording video | DOM `<video>` (MP4) | DOM `<video>` (MP4) (**identical**) |
| Tests | Vitest + jsdom + @testing-library/react (data + component render) | Jest (jest-expo): data + logic only |
| Native target | Capacitor → Android (wraps the web `dist/`) | Expo → Android/iOS (real RN, web is one renderer) |
| Entry | `main.tsx` → `<App>` in `index.html` | `index.ts` → `registerRootComponent(App)` |

## What's identical

- **Data layer** — `src/data/` (cameras, events, recordings, selectors, `types.ts`) is copied
  verbatim. Both apps render the same content. String-union state (`CameraStatus`,
  `DetectionType`) per project convention.
- **The video players' core** — both `LivePlayer`s attach hls.js to a DOM `<video>` with the same
  native-HLS-first fallback (`canPlayType('application/vnd.apple.mpegurl')` → hls.js → raw `src`).
  The RNW version simply renders that same `<video>` inside the RN tree (react-native-web renders
  to the DOM, so this is allowed). `VideoPlayer` (MP4) is likewise the same element.
- **Public sample streams** — Mux test HLS for "live", Google sample MP4s for "recordings".
- **Screen set & information architecture** — camera wall, focus view (player + activity +
  recordings rail), recordings list, global events feed, per-camera filtering.

## Where they diverge, and why

### Routing
Both builds now have **real, URL-addressable routes** — they just get there through their stack's
native router:
- **Capacitor:** `IonReactRouter` + `IonRouterOutlet` (`/live`, `/live/:cameraId`,
  `/playback/:recordingId`, …), wrapped in `IonSplitPane` for the sidebar.
- **RNW:** **Expo Router** (file-based, built on React Navigation). The `app/` directory *is* the
  route table (`app/camera/[cameraId].tsx` → `/camera/:cameraId`); params are read with
  `useLocalSearchParams`, navigation with `useRouter`. Deep links, refresh, and browser
  back/forward all work, and the same routes drive a native build.

> **History note:** the RNW build first shipped a hand-rolled in-memory route stack (`NavProvider`
> + a `Route` discriminated union, **no URLs**) to dodge React Navigation's web-setup weight. Once
> shareable/refresh-proof URLs became a requirement, that was the wrong trade and Expo Router
> replaced it — at the cost of a heavier dependency set (`react-native-screens`,
> `react-native-safe-area-context`, reanimated). The screens, data layer, and players didn't
> change; only the router/param plumbing and the shell location did.

### Layout & responsiveness
- **Capacitor:** `IonSplitPane` gives the permanent-sidebar / collapsing-drawer behavior for free
  at the `md` breakpoint; the camera wall is a CSS grid (`auto-fill, minmax(...)`).
- **RNW:** the shell reimplements this by hand — `useWindowDimensions` for the ≥768 sidebar /
  hamburger-drawer split, and the wall measures its own width via `onLayout` and computes column
  count from a minimum tile width. Same result, manual implementation, because RN has no CSS grid.

### Styling
- **Capacitor:** CSS files per component/page + Ionic's CSS-variable theme (`theme/variables.css`).
- **RNW:** no CSS — a `theme/colors.ts` module + `StyleSheet.create` objects co-located in each
  component. (One cosmetic note: `StatusDot` uses `shadow*` props that emit an RNW deprecation
  warning — harmless.)

### Testing
- **Capacitor:** Vitest + jsdom + @testing-library/react. Covers data integrity **and** component
  rendering (`CameraTile`, `EventListItem`, `LivePlayer`) — natural because the Ionic/React DOM
  stack mounts `<video>` directly.
- **RNW:** Jest (jest-expo), data + logic only (`data.test.ts`, `detection.test.ts`). The
  jest-expo **native** renderer can't mount `LivePlayer`'s DOM `<video>`, so the UI/streaming
  surface is verified in a real browser instead (the meaningful proof for a web app) rather than
  through a render-test harness. See the RNW README's "Tests" section.

### Native path
- **Capacitor:** ships the built web bundle (`dist/`) inside a native WebView. The Android app
  *is* the web app. `npx cap add android` is the next step; no per-screen native code.
- **RNW:** the screens are **real React Native** — on a native build they render to native views,
  not a WebView. The only web-specific code is the two DOM-`<video>` players; swapping them for
  `expo-video` is the whole native-video task. `npx expo run:android` is the next step.

## One-line takeaway

Same product, same data, same look, **and now both are URL-addressable**. **Capacitor = web app in
a native shell** (Ionic router, CSS/Ionic, WebView on device). **RNW = real native UI that also
runs on the web** (Expo Router, hand-rolled responsive layout, StyleSheet, native views on device)
— with DOM `<video>` as the one web seam to replace for a true native build.
