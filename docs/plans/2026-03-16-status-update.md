# Project Status Update — 2026-03-16

## Goal

Stream live video and playback from a Hikvision NVR (behind NAT, no port forwarding) to a web browser, using the existing Hik-Connect cloud infrastructure.

## What We Built

### Phase 1: Hik-Connect REST API Client (COMPLETE)

Fully working TypeScript client that authenticates with Hik-Connect and fetches all streaming parameters.

**Files:** `src/lib/hikconnect/` (client, types, session, routes)

**API endpoints implemented:**
- `POST /v3/users/login/v2` — login with MD5-hashed password
- `PUT /v3/apigateway/login` — session refresh
- `GET /v3/userdevices/v1/resources/pagelist` — device list
- `GET /v3/userdevices/v1/cameras/info` — camera channels
- `GET /v3/streaming/ticket/{serial}/{channel}` — stream ticket
- `GET /v3/streaming/vtm/{serial}/{channel}` — VTM relay server info
- `GET /v3/streaming/query/{type}/{serial}/{channel}` — relay server + ECDH public key
- `GET /v3/streaming/records` — recording file list

**Verified against real API** (integration test passing):
- NVR: L38239367 (HNR33P8-8/D, 8 cameras)
- API domain: `apiius.hik-connect.com`
- VTM relay: `vtmvirginia.ezvizlife.com` / `148.153.53.29:8554`
- Relay server: `148.153.39.254:6123` with EC P-256 public key

### Phase 2: Protocol Capture via Frida (COMPLETE)

Captured complete streaming protocol parameters using Frida on Android emulator.

**Key findings from Frida Java hooks on `NativeApi.createPreviewHandle`:**
- Connection uses **P2P v3 over UDP** (not TCP relay)
- NVR public IP: `24.35.64.195`, command port 9010, stream port 9020
- CAS broker: `34.194.209.167:6500`
- STUN server: `43.130.155.63:6002`
- P2P link key: 32-byte key, version 101
- Stream encryption key: device verification code (6 chars)
- Client session: JWT (HS384) from login
- `streamInhibit=10` (disable DIRECT_OUTER + DIRECT_REVERSE)

**Packet capture confirmed:**
- Video flows via direct UDP P2P between app and NVR
- Framing marker: `0x55667788` in video packets
- ACK packets: `0x8002` prefix, 44 bytes
- Video packets: 229-361 bytes with encrypted payload

### Phase 3: Native Library Loading (BLOCKED)

Attempted to load `libezstreamclient.so` outside Android.

**Approach 1: ARM64 Linux + FFI**
- Extracted 77 .so files from APK
- All exports are JNI functions (`Java_com_ez_stream_NativeApi_*`)
- Libraries depend on Android's bionic libc (`LIBC` version symbol)
- glibc is ABI-incompatible — `patchelf` can't bridge the gap
- **Result: NOT VIABLE** on bare Linux

**Approach 2: iOS binary extraction**
- iOS app has same C++ streaming engine (same class names in symbols)
- But it's statically linked into an 88MB Mach-O binary
- Can't extract or run on Linux
- **Result: NOT VIABLE**

**Approach 3: redroid (Android in Docker)**
- Hetzner CAX11 ARM64 server provisioned (`178.104.67.226`)
- redroid (Android 14) running in Docker with binder support
- Hik-Connect APK installed successfully
- Frida gadget injection working via LD_PRELOAD
- Java hooks confirmed working
- **Blocker:** UI automation on headless redroid (swipe input doesn't register for onboarding ViewPager)
- **Status: PARTIALLY WORKING** — needs either scrcpy for one-time manual login, or a headless bridge app

## Infrastructure

| Resource | Details |
|----------|---------|
| Hetzner CAX11 | `178.104.67.226`, ARM64, 2 vCPU, 4GB RAM, Ubuntu 24.04 |
| redroid | Android 14 in Docker, Hik-Connect installed |
| Frida gadget | Working inside redroid via LD_PRELOAD wrap.sh |
| Android emulator (local) | WSL2, x86_64 with ARM translation, used for Phase 2 capture |
| OCI | Account exists (us-sanjose-1), no ARM capacity available |

## Approaches Evaluated

| Approach | Viable? | Why |
|----------|---------|-----|
| EZVIZ Open Platform API (HLS) | Unknown | Would give HLS URLs directly. Requires EZVIZ developer registration. NVR is on ezvizlife.com infra. **Not yet tested.** |
| Hik-Connect API + VTDU relay RE | Partially | API client works. VTDU binary protocol not reversed — it's UDP P2P, not TCP. |
| Native .so FFI on ARM64 Linux | No | bionic libc ABI incompatible with glibc |
| iOS binary extraction | No | Statically linked Mach-O |
| redroid + Frida frame extraction | Partially | Infra works but headless UI navigation blocked |
| redroid + custom bridge app (no Frida) | Not tried | Write Android service that calls NativeApi directly, pipes frames to stdout |
| ISUP/EHome SDK (official) | Not applicable | Requires NVR reconfiguration away from Hik-Connect. User constraint: must work with vanilla Hik-Connect. |
| Full UDP P2P protocol RE | Not tried | Build CAS + STUN + P2P client from scratch using captured data |

## Recommended Next Steps (in order of effort/risk)

### 1. EZVIZ Open Platform API (lowest effort, unknown viability)
Register at EZVIZ developer portal, get appKey, test if `/api/lapp/live/address/get` returns HLS URLs for existing Hik-Connect devices. 30 minutes to validate.

### 2. redroid + scrcpy one-time login (low effort)
SSH tunnel to redroid, use scrcpy to visually complete onboarding + login once. After that, session persists and Frida hooks can capture frames programmatically.

### 3. Android bridge app on redroid (medium effort)
Write a minimal Android app/service that calls `NativeApi.initSDK()` / `createPreviewHandle()` / `startPreview()` directly. Receives frames via callback, writes to stdout. No Frida needed. Runs headless.

### 4. Full UDP P2P protocol RE (high effort)
Use the Frida captures + packet dumps to reverse engineer the CAS broker protocol, STUN handshake, and UDP P2P framing. Build a Node.js implementation from scratch. Most independent but 4-6 weeks of work.
