# HikConnect Web

Web client for Hikvision NVRs/cameras that streams video via the Hik-Connect cloud, bypassing the need for port forwarding.

## Project Status

**Phase 1 (REST API client):** Complete. Login, devices, cameras, stream tickets, VTM info, relay config, recordings.

**Phase 2 (protocol reverse engineering):** In progress. P2P server handshake works (SUCCESS response). Video not yet flowing — blocked on NAT traversal (P2P path) and ECDH handshake (VTM relay path).

**Phase 3 (streaming + UI):** Skeleton built. LiveStream pipeline, FFmpeg HLS, web player all wired up. Needs a working P2P or VTM connection to deliver actual video.

## Architecture

```
Browser (Next.js) → API Routes → P2P/VTM Client → Device (via cloud)
                                        ↓
                                  FFmpeg → HLS segments
                                        ↓
                                  HLS.js player ← Browser
```

### Key Modules

| Module | Path | Purpose |
|--------|------|---------|
| HikConnect API client | `src/lib/hikconnect/client.ts` | REST API: login, devices, tickets, P2P config |
| V3 protocol codec | `src/lib/p2p/v3-protocol.ts` | Hikvision binary protocol: encode/decode, TLV, CRC-8 |
| P2P session | `src/lib/p2p/p2p-session.ts` | UDP P2P: server handshake, hole punch, data exchange |
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

```bash
npx tsx scripts/test-p2p-v2.ts      # Test P2P server handshake (needs .env.local)
npx tsx scripts/test-vtm-connect.ts  # Test VTM relay connection
npx tsx scripts/test-p2p-connect.ts  # Basic P2P connection test
```

### Frida (Android emulator)

```bash
frida -U -p <PID> -l scripts/frida/get-p2p-key.js    # Capture P2PServerKey
frida -U -p <PID> -l scripts/frida/hook-stream-broad.js  # Broad network hooks
```

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
| `protocol-notes.md` | **Primary reference.** Complete P2P + VTM protocol spec: packet formats, keys, ECDH handshake, error codes |
| `deferred-work.md` | Outstanding work items with priority and status |
| `api-notes.md` | API response shapes, P2P config injection model |
| `v3-protocol-opcodes.md` | V3 binary protocol opcode table |
| `crypto-analysis.md` | Crypto algorithms from Ghidra RE |
| `cas-broker-protocol.md` | CAS TCP broker protocol |
| `stun-p2p-protocol.md` | STUN and P2P server protocol |

### Key Protocol Constants

- **P2PServerKey:** `e4465f2d011ebf9d85eb32d46e1549bdf64c171d616a132afaba4b4d348a39d5` (stable per account, from Frida)
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
