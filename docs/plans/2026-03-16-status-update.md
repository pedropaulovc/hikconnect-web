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
| ~~Hetzner CAX11~~ | ~~`178.104.67.226`, ARM64, 2 vCPU, 4GB RAM, Ubuntu 24.04~~ **DELETED 2026-03-17** — compromised via exposed ADB port, see [Incident Report](#incident-report-2026-03-17) |
| ~~redroid~~ | ~~Android 14 in Docker, Hik-Connect installed~~ **Lost with server** |
| Frida gadget | Working inside redroid via LD_PRELOAD wrap.sh |
| Android emulator (local) | WSL2, x86_64 with ARM translation, used for Phase 2 capture |
| OCI | Account exists (us-sanjose-1), no ARM capacity available |

## Incident Report (2026-03-17)

**What happened:** The Hetzner CAX11 server running redroid was compromised via its exposed ADB port (TCP 5555). An automated ADB worm connected to the unauthenticated ADB service, obtained shell access to the Android container, and used it to scan ~230 other Hetzner IPs on port 5555 within 3 seconds. Hetzner detected the netscan and issued an abuse complaint (ID: 2603:MHNJ7APBQSWE).

**Root cause:** The redroid Docker container was started with ADB port 5555 mapped to `0.0.0.0` (all interfaces) instead of `127.0.0.1` (localhost only). ADB provides unauthenticated root shell access by default, making this equivalent to leaving an open root shell on the internet.

**Resolution:** Server deleted immediately. No sensitive data was stored on the server (only the Hik-Connect APK and Frida scripts, all of which are in this repo).

**Prevention:** See [Security Requirements for redroid Deployment](#security-requirements-for-redroid-deployment) below.

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
| Full UDP P2P protocol RE | **In progress** | Ghidra static RE complete. ChaCha20 encryption (not AES), ECDH P-256 key exchange, 11-byte header + HMAC-SHA256 packet format all reversed. CAS broker + P2P net architecture documented. See `docs/re/` |

## Recommended Next Steps (in order of effort/risk)

### 1. EZVIZ Open Platform API (lowest effort, unknown viability)
Register at EZVIZ developer portal, get appKey, test if `/api/lapp/live/address/get` returns HLS URLs for existing Hik-Connect devices. 30 minutes to validate.

### 2. redroid + scrcpy one-time login (low effort)
SSH tunnel to redroid, use scrcpy to visually complete onboarding + login once. After that, session persists and Frida hooks can capture frames programmatically.

### 3. Android bridge app on redroid (medium effort)
Write a minimal Android app/service that calls `NativeApi.initSDK()` / `createPreviewHandle()` / `startPreview()` directly. Receives frames via callback, writes to stdout. No Frida needed. Runs headless.

### 4. Full UDP P2P protocol RE (ACTIVE — Phase A complete)
Static RE via Ghidra + kawaiidra-mcp completed 2026-03-17. Major findings:
- **Encryption:** ChaCha20 (not AES) with HMAC-SHA256. All natively supported in Node.js.
- **Key exchange:** ECDH P-256 via mbedTLS. Natively supported in Node.js.
- **Packet format:** 11-byte header (`$\x02` magic + length + seqnum) + encrypted payload + 32-byte HMAC
- **CAS broker:** CTransferClientMgr, v2.16.2.20250108, uses protobuf (PdsInfo)
- **P2P net:** CP2PManager, v1.1.0.211018, STUN hole-punching
- **SRT:** Secure Reliable Transport also initialized (possible fallback)
- **Full docs:** `docs/re/jni-exports.md`, `docs/re/cas-broker-protocol.md`, `docs/re/stun-p2p-protocol.md`, `docs/re/crypto-analysis.md`

**Next:** Phase B (dynamic validation with Frida on Hetzner ARM VM) to capture actual CAS TCP messages and verify packet format.

---

## Security Requirements for redroid Deployment

> **Added 2026-03-17** after ADB port compromise incident. These are mandatory for any future redroid/Android emulator deployment.

### Network binding rules

1. **NEVER expose ADB (port 5555) to `0.0.0.0`**. Always bind to localhost:
   ```bash
   # CORRECT
   docker run -d --privileged -p 127.0.0.1:5555:5555 redroid/redroid:14.0.0-latest

   # WRONG — allows anyone on the internet to get root shell
   docker run -d --privileged -p 5555:5555 redroid/redroid:14.0.0-latest
   ```

2. **Access ADB via SSH tunnel only:**
   ```bash
   ssh -L 5555:127.0.0.1:5555 root@<server-ip>
   adb connect 127.0.0.1:5555
   ```

3. **scrcpy via SSH tunnel:**
   ```bash
   ssh -L 5555:127.0.0.1:5555 root@<server-ip>
   scrcpy -s 127.0.0.1:5555
   ```

### Firewall rules (apply on every new server)

```bash
# Default deny inbound, allow only SSH
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw enable

# Explicitly block ADB even if Docker tries to bypass ufw
iptables -I DOCKER-USER -p tcp --dport 5555 -j DROP
iptables -I DOCKER-USER -p tcp --dport 5555 -s 127.0.0.1 -j ACCEPT
```

### Server provisioning checklist

- [ ] UFW enabled with default deny before starting any containers
- [ ] ADB port bound to `127.0.0.1` only
- [ ] `DOCKER-USER` iptables chain blocks 5555 from non-localhost
- [ ] Verify with `ss -tlnp | grep 5555` — must show `127.0.0.1:5555`, not `0.0.0.0:5555`
- [ ] No secrets stored on the server (everything in repo or env vars via SSH)
