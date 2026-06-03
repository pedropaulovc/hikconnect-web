# HikConnect Web

Web client for Hikvision NVRs/cameras that streams video via the Hik-Connect cloud, bypassing the need for port forwarding.

## Project Status

**Phase 1 (REST API client):** Complete. Login, devices, cameras, stream tickets, VTM info, relay config, recordings.

**Phase 2 (protocol reverse engineering):** Complete. Full P2P streaming pipeline reverse-engineered from iVMS-4200 (Ghidra) and verified on VPS. P2P_SETUP → hole-punch → SRT → H.265 video data flowing.

**Phase 3 (streaming + UI):** Complete. Live preview and playback both produce verified HEVC video, **credentials-only (no hardcoded keys/codes) and reliably** (20/20 back-to-back). The test NVR's Ch 1 source streams, measured from the raw H.265 before FFmpeg (`scripts/diag-source-resolution.ts`), are **main = 3840×2160 (true 4K)** and **sub = 640×480**, both HEVC Main. On a GPU host the pipeline NVDEC+NVENC transcodes to H.264 at **full source resolution** (no downscale; verified H.264 3840×2160 HLS segments end-to-end); the CPU `libx264` fallback downscales (main→720p, sub→360p) since realtime 4K H.264 on CPU is infeasible. Verified end-to-end through the web UI (16/16 clean frames over ~60s) after the SRT reorder-buffer fix.
- **Live preview** (busType=1): Hik-RTP framing → H.265 NAL extraction → FFmpeg HLS. Verified sustained 4K HEVC.
- **Playback** (busType=2): MPEG-PS container over Hik-RTP → FFmpeg demux. Verified 8.4MB recent-recording playback (NVR retention rotates old recordings off — query a recent time).

**Key discovery:** Playback streams use MPEG Program Stream (PS) container, NOT raw H.265 NALs like live preview. The NVR stores recordings as PS files and streams them as-is. Strip 12-byte Hik-RTP headers from 0x8050 packets and pipe to FFmpeg as `-f mpeg`.

**Reliability fix (2026-06-03):** The intermittent "reaches streaming but ~0 video / stalls after a burst" failure was an SRT ACK bug, NOT device contention. The device runs two SRT sub-sessions (control `0x807f` keepalives + video) with independent sequence spaces on one socket; a single shared `lastAckSeq` let control sequences pollute the video ACK → device flow-control stalled. Fixed in `handleSrtDataPacket` by routing on payload type. See `docs/re/2026-06-03-streaming-regression-investigation.md`.

**Next steps:**
1. Production hardening: error recovery, multi-channel
2. Browser playback UI: timeline scrubber, recording list, camera selector
3. Playback HLS integration: pipe PS→FFmpeg→HLS for browser playback

## Architecture

```
Browser (Next.js) → API Routes → P2P Session → Device (via P2P cloud)
                                        ↓
                                  FFmpeg → HLS segments
                                        ↓
                                  HLS.js player ← Browser
```

### P2P Connection Flow (reverse-engineered)

```
Client                    P2P Server (52.x:6000)      Device (NVR)
  │                              │                        │
  │── P2P_SETUP (0x0B02) ──────→│                        │
  │←─ 0x0B03 (device info) ─────│                        │
  │                              │── notify device ──────→│
  │←─ 0x0C00 (hole punch req) ─────────────────────────│
  │── 0x0C01 (punch rsp, 10x) ─────────────────────────→│
  │                              │                        │
  │── PLAY_REQUEST (0x0C02) direct ────────────────────→│
  │── TRANSFOR_DATA (0x0B04) ───→│── relay PLAY_REQ ────→│
  │←─ 0x0B05 (SUCCESS) ─────────│                        │
  │                              │                        │
  │←════════════ video data (SRT/UDP) ═══════════════════│
```

### Key Modules

| Module | Path | Purpose |
|--------|------|---------|
| HikConnect API client | `src/lib/hikconnect/client.ts` | REST API: login, devices, tickets, P2P config |
| V3 protocol codec | `src/lib/p2p/v3-protocol.ts` | Hikvision binary protocol: encode/decode, TLV, CRC-8 |
| P2P session | `src/lib/p2p/p2p-session.ts` | UDP P2P: P2P_SETUP, hole punch, SRT handshake, PLAY_REQUEST |
| Hik-RTP extractor | `src/lib/p2p/hik-rtp.ts` | Strip Hik-RTP/sub-headers, extract H.265 NALs, AES decrypt |
| Relay client | `src/lib/p2p/relay-client.ts` | TCP relay: ECDH handshake, TLV framing (blocked on KDF) |
| VTM client | `src/lib/p2p/vtm-client.ts` | TCP VTM relay: protobuf framing, ECDH (incomplete) |
| Device P2P framing | `src/lib/p2p/device-p2p.ts` | Device-side packet types: 7534/80xx/41ab |
| IMKH parser | `src/lib/p2p/imkh-parser.ts` | Hikvision media container: frame extraction, AES decrypt |
| LiveStream | `src/lib/p2p/live-stream.ts` | End-to-end: P2P → IMKH demux → FFmpeg HLS |
| FFmpeg HLS pipe | `src/lib/hls/ffmpeg-pipe.ts` | Spawns FFmpeg, pipes raw video → .ts + .m3u8 |
| STUN client | `src/lib/p2p/stun-client.ts` | SafeProtocol (proprietary) + RFC 5389 STUN |
| CAS client | `src/lib/p2p/cas-client.ts` | TCP CAS broker: V3 framing over TCP |
| Crypto | `src/lib/p2p/crypto.ts` | ChaCha20 + HMAC-SHA256, ECDH P-256 |

### API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/auth/login` | POST | Login with Hik-Connect credentials |
| `/api/devices` | GET | List devices |
| `/api/devices/[serial]/cameras` | GET | List cameras |
| `/api/devices/[serial]/[ch]/ticket` | GET | Stream ticket |
| `/api/devices/[serial]/[ch]/vtm` | GET | VTM relay server info |
| `/api/stream/start` | POST | Start live stream → returns HLS URL |
| `/api/stream/playback` | POST | Start playback stream |
| `/api/stream/stop` | POST | Stop stream |
| `/api/stream/[...path]` | GET | Serve HLS files (.m3u8, .ts) |

## Tech Stack

- **Runtime:** Node.js 25, TypeScript strict
- **Framework:** Next.js 16 (App Router)
- **Testing:** Vitest (239 tests passing, 1 skipped)
- **Video:** FFmpeg H.265→H.264 transcode to HLS (NVDEC+NVENC full-res on GPU, libx264 downscale fallback), HLS.js (browser playback)
- **Crypto:** Node.js native crypto (AES, ChaCha20, ECDH, HMAC)
- **RE tools:** Frida (Android hooking), Ghidra (binary decompilation), tcpdump

## Commands

```bash
npm run dev          # Start dev server
npm run build        # Production build
npm run typecheck    # TypeScript check (ignore scripts/test-e2e-stream.ts errors)
npm test -- --run    # Run all tests (239 pass, 1 skipped)
```

### Protocol Testing

No VPS required — P2P server derives our NAT-mapped address from UDP packet source. Works behind home/office NAT.

All scripts fetch the P2P server key + salt fresh via `client.getP2PSecret()` — no keys are
hardcoded. Live + playback verified credentials-only (2026-06-03).

```bash
npx tsx scripts/probe-p2p-config.ts     # Fetch + decode the P2P server key from /api/p2p/configurations
npx tsx scripts/test-p2p-dynamic.ts     # Full P2P test: login → P2P_SETUP → PLAY_REQUEST
npx tsx scripts/test-p2p-to-ffmpeg.ts   # Live stream → H.265 → FFmpeg → HLS
npx tsx scripts/test-playback-ps.ts [t] # Playback (t=YYYY-MM-DDTHH:MM:SS) → MPEG-PS → FFmpeg → MP4
npx tsx scripts/probe-recordings.ts [d] # List recordings (d=YYYY-MM-DD)
npx tsx scripts/probe-alarms.ts            # List alarm events (verify /v3/alarms/advanced live)
npx tsx scripts/diag-stream-reliability.ts [n] [cooldownSec]  # Stream reliability + clientId diagnostic
npx tsx scripts/diag-srt-reorder.ts [holdSec]  # Per-packet SRT reorder/loss detector
npx tsx scripts/diag-source-resolution.ts <streamType> [holdSec]  # ffprobe the raw H.265 SOURCE resolution (1=main 4K, 2=sub 640x480)
npx tsx scripts/test-vtm-connect.ts     # Test VTM relay connection
```

### NAT Traversal

The P2P protocol works behind NAT without a public IP:
1. Our UDP socket sends P2P_SETUP to the P2P server
2. P2P server observes our NAT-mapped address from the packet source (like STUN)
3. P2P server tells the device where we are
4. Device sends hole-punch (0x0C00) to our NAT-mapped address
5. Our NAT allows the response because we already sent outbound from the same port
6. PLAY_REQUEST is also relayed via TRANSFOR_DATA (0x0B04) as fallback

Optional: set `PUBLIC_IP=x.x.x.x` to provide a hint, but this is not required.

### Android Emulator

App package: `com.connect.enduser` (Hik-Connect). Always use `uiautomator dump` to find element bounds before tapping — never guess coordinates.

```bash
# UI automation (ALWAYS dump bounds first, never guess coordinates)
adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml /tmp/ui.xml
grep -oP 'text="[^"]*"[^>]*bounds="[^"]*"' /tmp/ui.xml   # find elements
adb shell input tap X Y                                     # tap at bounds center
adb shell screencap -p /sdcard/screen.png && adb pull /sdcard/screen.png /tmp/screen.png

# App lifecycle
adb shell am force-stop com.connect.enduser                 # kill app
adb shell monkey -p com.connect.enduser -c android.intent.category.LAUNCHER 1  # launch app

# Frida hooks
frida -U -p <PID> -l scripts/frida/get-p2p-key.js        # Capture P2PServerKey
frida -U -p <PID> -l scripts/frida/get-p2p-link-key.js   # Capture P2PLinkKey + all InitParam fields
frida -U -p <PID> -l scripts/frida/hook-stream-broad.js   # Broad network hooks
```

### Reference Frames

`docs/re/reference-frames/` — screenshots from working clients for visual comparison with our pipeline output.
- `lobby-live-android-2026-03-18.png` — Lobby camera live view from Android app (single-camera mode)

## Environment

`.env.local` (not committed):
```
HIKCONNECT_BASE_URL="https://api.hik-connect.com"
HIKCONNECT_ACCOUNT="user@example.com"
HIKCONNECT_PASSWORD="password"
```

## Reverse Engineering Docs

All protocol documentation lives in `docs/re/`:

| File | Content |
|------|---------|
| `protocol-notes.md` | **Primary reference.** Complete P2P + VTM + relay protocol spec. Includes iVMS-4200 Ghidra RE findings |
| `deferred-work.md` | Outstanding work items with priority and status |
| `api-notes.md` | API response shapes, P2P config injection model |
| `v3-protocol-opcodes.md` | V3 binary protocol opcode table |
| `crypto-analysis.md` | Crypto algorithms from Ghidra RE |
| `cas-broker-protocol.md` | CAS TCP broker protocol |
| `cas-session-flow.md` | Full CAS session establishment sequence (STUN → P2P_SETUP → stream) |
| `stun-p2p-protocol.md` | STUN and P2P server protocol |
| `p2p-config-source.md` | Where each config element comes from (JNI → native mapping) |
| `jni-exports.md` | JNI function signatures and InitParam field mapping |
| `reference-frames/` | Screenshots from working clients (Android app) for visual comparison |

### Key Protocol Constants

- **P2PServerKey:** fetched fresh per session — `POST /api/p2p/configurations` → `secret.data`
  (`"[b0,…,b31]"` decimal bytes) + `secret.saltIndex` (0–7) + `secret.version` (saltVer).
  NEVER hardcode: the server holds 8 salt-indexed keys and returns one per call; the saltIndex
  we send tells it which to decrypt with. `client.getP2PSecret()`. This endpoint also returns
  the P2P server list. (Was the streaming-regression root cause — see
  `docs/re/2026-06-03-streaming-regression-investigation.md`.)
- **clientId** (PLAY_REQUEST expand-header tag 0x02): NOT validated — a client-side correlation
  id. Generated random per session via `randomClientId()` (`src/lib/p2p/client-id.ts`).
- **userId:** derived from the JWT `sessionId` `aud` claim via `extractUserId()`.
- **P2PLinkKey:** first 32 ASCII chars of API KMS `secretKey` (inner PLAY_REQUEST encryption).
- **AES IV (all V3 encryption):** `"01234567" + 8 zero bytes` (0x30313233343536370000000000000000)
- **CRC-8:** Custom Hikvision bitwise algorithm (NOT polynomial 0x39). See `v3-protocol.ts`.
- **V3 reserved field:** `0x6234` (protocol version constant in all V3 headers)
- **VTM server:** `148.153.53.29:8554` (vtmvirginia.ezvizlife.com)
- **Stream tokens:** `POST /api/user/token/get` with `sessionId` + `clientType=55`

## Coding Conventions

- Enums as const objects (not TypeScript `enum`): `const Opcode = { X: 0x01 } as const`
- Flat code, avoid nesting, early returns
- No classes for pure data — use types + functions. Classes only for stateful objects (sessions, connections)
- Booleans limited to single functions; use string unions for cross-boundary state
- All protocol buffers are `Buffer`, not `Uint8Array`
- Tests in `__tests__/` directories or `.test.ts` files
