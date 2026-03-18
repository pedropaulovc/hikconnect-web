# HikConnect Web

Web client for Hikvision NVRs/cameras that streams video via the Hik-Connect cloud, bypassing the need for port forwarding.

## Project Status

**Phase 1 (REST API client):** Complete. Login, devices, cameras, stream tickets, VTM info, relay config, recordings.

**Phase 2 (protocol reverse engineering):** Complete. Full P2P streaming pipeline reverse-engineered from iVMS-4200 (Ghidra) and verified on VPS. P2P_SETUP → hole-punch → SRT → H.265 video data flowing.

**Phase 3 (streaming + UI):** Pipeline functional. 343 H.265 frames decoded (4K), 9 HLS segments generated. Blocked on device verification code for AES decryption of video slices.

**Next steps:**
1. Get the NVR verification code (6-char code from device sticker or Hik-Connect app → Device Settings)
2. Update `HikRtpExtractor` with correct AES-128-ECB decryption using `MD5(verificationCode)`
3. Run `./scripts/test-full-pipeline.sh` on VPS for end-to-end browser playback

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

```bash
npx tsx scripts/test-p2p-dynamic.ts     # Full P2P test: login → P2P_SETUP → PLAY_REQUEST (needs VPS with public IP)
npx tsx scripts/test-p2p-v2.ts          # Legacy P2P server handshake test
npx tsx scripts/test-vtm-connect.ts     # Test VTM relay connection
```

### Running the Full Pipeline

The P2P video streaming pipeline requires a server with a public IP (the device needs to UDP hole-punch to us). Deploy to a VPS:

```bash
# 1. Create VPS
hcloud server create --name hikp2p --type cpx11 --location ash --image ubuntu-24.04 --ssh-key hikconnect

# 2. Deploy + install
rsync -az --exclude node_modules --exclude .next --exclude .git . root@IP:/root/hikconnect-web/
ssh root@IP 'curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs ffmpeg'
ssh root@IP 'cd /root/hikconnect-web && npm install'

# 3. Test P2P pipeline (saves H.265 + generates HLS)
ssh root@IP 'cd /root/hikconnect-web && PUBLIC_IP=<VPS_IP> npx tsx scripts/test-p2p-to-ffmpeg.ts'

# 4. Run web app (Next.js on port 3000)
ssh root@IP 'cd /root/hikconnect-web && PUBLIC_IP=<VPS_IP> npx next dev --hostname 0.0.0.0'

# 5. Cleanup
hcloud server delete hikp2p
```

**Important:** The NVR limits concurrent P2P streams. Wait 30+ seconds between connection attempts. After many rapid connections (~20), the device may need hours of cooldown or a reboot.

### VPS for P2P Testing

```bash
hcloud server create --name hikp2p --type cpx11 --location ash --image ubuntu-24.04 --ssh-key hikconnect
# Deploy: rsync -az --exclude node_modules --exclude .next --exclude .git . root@IP:/root/hikconnect-web/
# Install: ssh root@IP 'curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs'
# Test: ssh root@IP 'cd /root/hikconnect-web && npm install && npx tsx scripts/test-p2p-dynamic.ts'
# Cleanup: hcloud server delete hikp2p
```

### Frida (Android emulator)

```bash
frida -U -p <PID> -l scripts/frida/get-p2p-key.js        # Capture P2PServerKey
frida -U -p <PID> -l scripts/frida/get-p2p-link-key.js   # Capture P2PLinkKey + all InitParam fields
frida -U -p <PID> -l scripts/frida/hook-stream-broad.js   # Broad network hooks
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
