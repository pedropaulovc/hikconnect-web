# HikConnect Web

Web client for Hikvision NVRs/cameras that streams video via the Hik-Connect cloud, bypassing the need for port forwarding.

## Project Status

**Phase 1 (REST API client):** Complete. Login, devices, cameras, stream tickets, VTM info, relay config, recordings.

**Phase 2 (protocol reverse engineering):** Complete. Full P2P streaming pipeline reverse-engineered from iVMS-4200 (Ghidra) and verified on VPS. P2P_SETUP → hole-punch → SRT → H.265 video data flowing.

**Phase 3 (streaming + UI):** Complete. Live preview and playback both produce verified 4K video.
- **Live preview** (busType=1): Hik-RTP framing → H.265 NAL extraction → FFmpeg HLS. Verified 87s footage from pcap.
- **Playback** (busType=2): MPEG-PS container over Hik-RTP → FFmpeg demux. Verified 64s of recorded footage from 2026-03-15.

**Key discovery:** Playback streams use MPEG Program Stream (PS) container, NOT raw H.265 NALs like live preview. The NVR stores recordings as PS files and streams them as-is. Strip 12-byte Hik-RTP headers from 0x8050 packets and pipe to FFmpeg as `-f mpeg`.

**Next steps:**
1. Production hardening: session management, error recovery, multi-channel
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
- **Testing:** Vitest (98 tests passing)
- **Video:** FFmpeg (transmux to HLS), HLS.js (browser playback)
- **Crypto:** Node.js native crypto (AES, ChaCha20, ECDH, HMAC)
- **RE tools:** Frida (Android hooking), Ghidra (binary decompilation), tcpdump

## Commands

```bash
npm run dev          # Start dev server
npm run build        # Production build
npm run typecheck    # TypeScript check (ignore scripts/test-e2e-stream.ts errors)
npm test -- --run    # Run all tests (98 pass, 1 skipped)
```

### Protocol Testing

No VPS required — P2P server derives our NAT-mapped address from UDP packet source. Works behind home/office NAT.

```bash
npx tsx scripts/test-p2p-dynamic.ts     # Full P2P test: login → P2P_SETUP → PLAY_REQUEST
npx tsx scripts/test-p2p-to-ffmpeg.ts   # Live stream → H.265 → FFmpeg → HLS
npx tsx scripts/test-playback-ps.ts     # Playback → MPEG-PS → FFmpeg → MP4
npx tsx scripts/test-p2p-v2.ts          # Legacy P2P server handshake test
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

- **P2PServerKey:** `e4465f2d011ebf9d85eb32d46e1549bdf64c171d616a132afaba4b4d348a39d5` (stable per account, from Frida)
- **P2PLinkKey:** first 32 ASCII chars of API KMS `secretKey` (from Frida `szP2PLinkKey`)
- **AES IV (all V3 encryption):** `"01234567" + 8 zero bytes` (0x30313233343536370000000000000000)
- **CRC-8:** Custom Hikvision bitwise algorithm (NOT polynomial 0x39). See `v3-protocol.ts`.
- **V3 reserved field:** `0x6234` (protocol version constant in all V3 headers)
- **P2P servers:** `52.5.124.127:6000`, `52.203.168.207:6000`
- **VTM server:** `148.153.53.29:8554` (vtmvirginia.ezvizlife.com)
- **Stream tokens:** `POST /api/user/token/get` with `sessionId` + `clientType=55`

## Coding Conventions

- Enums as const objects (not TypeScript `enum`): `const Opcode = { X: 0x01 } as const`
- Flat code, avoid nesting, early returns
- No classes for pure data — use types + functions. Classes only for stateful objects (sessions, connections)
- Booleans limited to single functions; use string unions for cross-boundary state
- All protocol buffers are `Buffer`, not `Uint8Array`
- Tests in `__tests__/` directories or `.test.ts` files
