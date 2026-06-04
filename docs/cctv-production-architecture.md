# Production architecture — share the core, fork the UI

**Date:** 2026-06-04
**Context:** Both demo branches (`feature/cctv-demo-capacitor`, `feature/cctv-demo-react-native-web`)
proved the *product* end to end. This note sketches how to take it to production for a
**desktop-web-first NVR with a native mobile companion to follow**, without betting the primary
surface on a single cross-platform UI layer.

## Principle

A desktop camera wall and a phone viewer are **two products that share data and a streaming core**,
not one app at two widths. So: **share the logic, fork the presentation.** The hard, valuable part
(transport, demux, decode handshake, models, API) is platform-agnostic; the UI is not, and
shared-UI cross-platform tends to be mediocre on both ends.

## Monorepo layout

```
cctv/
  pnpm-workspace.yaml
  tsconfig.base.json              # shared compiler options; project references below
  packages/
    core/                         # NO DOM, NO react-native — pure TS
      src/
        models/                   # Camera, Recording, DetectionEvent + zod schemas
        api/                      # typed API client (injectable fetch/transport)
        streaming/                # P2P/VTM session, ECDH, SRT demux → MediaSink
        domain/                   # selectors, detection meta, time formatting (the demo's helpers)
      package.json                # exports map; deps: zod only. No react.
    ui-tokens/                    # plain-TS design tokens (colors, spacing) shared by both apps
  apps/
    web/                          # Vite + React — desktop NVR console (PRIMARY)
      src/
        video/                    # MSE/WebCodecs sink
        routes/ components/ ...    # desktop-grade UI (TanStack/React Router, hover, panes, shortcuts)
    mobile/                       # Expo (RN) — phone app (LATER)
      app/                        # expo-router
        video/                    # native-decoder sink (expo-video / vision-camera / native module)
        components/ ...
```

## What's shared vs forked

| Layer | Where | Shared? |
|---|---|---|
| Models + validation (`zod`) | `core/models` | ✅ shared |
| API client | `core/api` | ✅ shared |
| Streaming/protocol (P2P, ECDH, SRT demux) | `core/streaming` | ✅ shared |
| Selectors, detection meta, time formatting | `core/domain` | ✅ shared |
| Design tokens (colors/spacing) | `ui-tokens` | ✅ shared (as data, not components) |
| Screens, components, navigation | `apps/*` | ❌ **forked per platform** |
| Video rendering | `apps/*/video` | ❌ **forked** (see below) |

Components are forked on purpose: desktop wants hover, right-click, multi-pane drag-resize, keyboard
shortcuts, and many simultaneous tiles; the phone wants one stream, gestures, PiP, push. RNW makes
the desktop side second-class and the web target is Expo's least-invested one — so the desktop app
is plain React on Vite, and mobile is a real native Expo app. Neither imports the other's UI.

## The video seam (the one interface that matters)

`core/streaming` does transport + demux and emits media through a **sink interface** each app
implements. The decode/render target is the only platform-specific half of the pipeline:

```ts
// packages/core/src/streaming/sink.ts
export interface MediaSink {
  /** fMP4/CMAF segments, or raw frames if core also decodes. */
  pushSegment(data: Uint8Array, meta: SegmentMeta): void;
  onError(err: StreamError): void;
}
export function openStream(cameraId: string, sink: MediaSink): StreamHandle; // .close()
```

- **web sink** → `MediaSource` + `SourceBuffer` (or `WebCodecs VideoDecoder` → `<canvas>`) feeding a
  DOM `<video>`. This is the demo's `LivePlayer`, generalized from "attach hls.js" to "attach our
  own segment source."
- **mobile sink** → native player / `expo-video` / a small native module wrapping the hardware
  decoder.

Everything upstream of the sink — the P2P handshake, key rotation, SRT reassembly documented in
`docs/re/` — lives once in `core` and is tested once.

## Tooling

| Concern | Choice |
|---|---|
| Workspaces | pnpm (or bun) workspaces + TS project references |
| Web build/dev | Vite (fast inner loop; full web platform for video) |
| Mobile build | Expo + Metro |
| Tests | Vitest for `core` + `web`; jest-expo for `mobile` |
| Lint/format | one shared config (Biome or eslint+prettier) at root |
| Boundary enforcement | `core` tsconfig excludes `DOM`/`react-native` libs + an import-restriction lint rule, so a DOM/RN import in `core` fails CI |

## How the demos feed in

- `core/domain` ← lift `src/data/*` selectors + `src/components/detection.ts` from either demo (they're
  already platform-agnostic), then add `zod` schemas and swap the static fixtures for the real API
  client.
- `apps/web` ← seeded by the **Capacitor branch** (already Vite + React; drop Capacitor, keep the
  desktop NVR layout) — or start clean, since most Ionic components weren't used anyway.
- `apps/mobile` ← seeded by the **RNW branch** (Expo + screens + Expo Router), with its **web target
  dropped** and `LivePlayer`/`VideoPlayer` replaced by the native sink.

## Risks / notes

- **Decode budget is the real ceiling**, not the framework. A 16-tile wall is N simultaneous
  decodes; design for it — request substreams/low-res for tiles, full-res only on the focused
  camera, and decode only visible tiles. This constraint is identical on web and native and should
  live as policy in `core`.
- **Keep `core` honest** — no DOM, no RN, no app imports. Enforce in CI; it's what makes the fork
  pay off instead of rotting into a third tangled dependency.
- **Version the API client** against the real backend with contract tests; the demo's mock shapes
  are a starting point, not ground truth.

## If you must ship a single codebase instead

Then the weight decides: **mobile-first → RNW** (the branch we have, accept weaker desktop web);
**web-native, mobile light → Capacitor**. But for a desktop-first NVR, the shared-core/forked-UI
split above beats either single-codebase option.
