# Hik-Connect Web Streaming App — Design Document

## Goal

Replicate Hik-Connect mobile app's live view and playback functionality as a web application, targeting a Hikvision NVR behind NAT with no port forwarding, accessible only through Hik-Connect cloud relay.

## Reverse Engineering Findings

### Two API Stacks Discovered

The app contains two parallel API stacks:

**Stack A — EZVIZ/Legacy API** (used by `CameraApi.java` Retrofit interface):
- Base URL: `https://api.hik-connect.com` (regional variants exist)
- Auth: `POST /v3/users/login/v2` → `sessionId`
- Devices: `GET /v3/userdevices/v1/resources/pagelist`
- Cameras: `GET /v3/userdevices/v1/cameras/info?deviceSerial={serial}`
- Stream setup:
  - `GET /v3/streaming/ticket/{serial}/{channel}` → stream ticket
  - `GET /v3/streaming/vtm/{serial}/{channel}` → VTM server info (domain, IP, port)
  - `GET /v3/streaming/query/{type}/{serial}/{channel}` → relay server config (StreamServerConfig: domain, externalIp, port, publicKey)
- Records: `GET /v3/streaming/records?deviceSerial=...&startTime=...&stopTime=...`
- Headers: `sessionId`, `clientType: 55`, `featureCode: deadbeef`
- ISAPI proxy: `POST /v3/userdevices/v1/isapi`

**Stack B — Business/Team API** (used by `HCBLoginApi.java`, `VideoApi.java`):
- Auth: RSA key exchange → `POST ccfauth/public/key/v1/secret/get` → `POST resource/v1/vms/system/token/get` → `accessToken`
- Devices: `POST ccfres/v1/physicalresource/devices/brief/search`
- Stream URLs: `POST video/v1/preview/url/list` → returns `CommonUrl` with streaming URL + `streamSecretKey`
- Stream windows: `POST hccstreammgr/v1/stream/window/apply`

### Connection Strategy (Priority Order)

The native SDK (`libezstreamclient.so`) tries connections in this order:

| Priority | Type | Constant | How |
|----------|------|----------|-----|
| 1 | Direct Inner | 2 | LAN, device local IP |
| 2 | Direct Outer | 3 | WAN, device public IP (port forwarded) |
| 3 | Direct Reverse | 6 | STUN hole-punching, device connects to app |
| 4 | P2P | 1 | Via Hikvision P2P servers |
| 5 | VTDU Relay | 0 | Cloud relay server proxies video |
| 6 | Cloud Playback | 4 | Cloud-stored recordings |
| 7 | HCNetSDK | 7 | Direct to NVR via Hikvision Network SDK |

For our case (NVR behind NAT, no port forward), the app will use **P2P or VTDU relay**.

### VTDU/Relay Protocol

The relay connection is established via `EZP2PTransParamForAndroid` JNA structure:
```
serial_: Device serial number
channel_: Channel number
token_: Stream authentication token (from /v3/streaming/ticket)
relayAddr_: VTDU relay server address (from /v3/streaming/vtm)
relayPort_: VTDU relay server port
relayPublicKey_: ECDH public key (91 bytes, from StreamServerConfig)
relayPublicKeyVer_: Key version
```

The actual TCP protocol is **proprietary binary**, handled entirely by `libezstreamclient.so`. It:
1. Connects to VTDU relay server on given IP:port
2. Performs ECDH handshake using relay public key
3. Sends device serial + stream ticket for authentication
4. Receives encrypted Program Stream (PS) frames containing H.264/H.265 + audio
5. Frames are AES-encrypted using the device's `szPermanetkey` (verification code / encryption password)

### Stream Encryption

- Device encryption key source: `deviceParam.getEncryptPwd()` or `deviceParam.getDeviceStreamPassword()`
- Key is 6-character "verification code" set during device setup
- Passed to native SDK as `InitParam.szPermanetkey`
- ECDH key exchange for link-level encryption: `NativeApi.generateECDHKey()` → `setClientECDHKey()`
- Frame decryption happens in `libPlayCtrl.so` native library

### Native Libraries Required

| Library | Purpose |
|---------|---------|
| libezstreamclient.so | P2P/VTDU protocol, connection management |
| libPlayCtrl.so | Video frame decryption + demuxing |
| libHCPreview.so | Live preview via HCNetSDK |
| libHCPlayBack.so | Playback via HCNetSDK |
| libhcnetsdk.so | Hikvision Network SDK core |
| libConvergenceEncrypt.so | Unified encryption |
| libstunClient.so | STUN NAT traversal |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                Browser (Next.js)                     │
│  ┌────────┐  ┌──────────┐  ┌─────────────────────┐  │
│  │ Login  │  │ Devices  │  │  HLS.js Player      │  │
│  └───┬────┘  └────┬─────┘  └──────────┬──────────┘  │
└──────┼────────────┼───────────────────┼──────────────┘
       │            │                   │ HLS over HTTP
       ▼            ▼                   ▼
┌─────────────────────────────────────────────────────┐
│              Next.js API Routes                      │
│  /api/auth    /api/devices    /api/stream/:id        │
└──────┬────────────┬───────────────────┬──────────────┘
       │            │                   │
       ▼            ▼                   ▼
┌─────────────────────────────────────────────────────┐
│           Backend (Node.js process)                  │
│                                                     │
│  ┌─────────────────────────────────────┐            │
│  │ Hik-Connect REST Client             │            │
│  │ (login, devices, stream tickets)    │            │
│  └─────────────────────────────────────┘            │
│  ┌─────────────────────────────────────┐            │
│  │ VTDU Protocol Client (TCP)          │  ← Phase 2 │
│  │ (handshake, auth, frame reception)  │            │
│  └─────────────────────────────────────┘            │
│  ┌─────────────────────────────────────┐            │
│  │ Stream Decryptor + HLS Segmenter    │            │
│  │ (AES decrypt → FFmpeg → .ts/.m3u8)  │            │
│  └─────────────────────────────────────┘            │
└─────────────────────────────────────────────────────┘
       │            │                   │
       ▼            ▼                   ▼
  Hik-Connect    VTDU Relay        CAS Server
  API Server     (video data)    (device commands)
```

## Phased Implementation Plan

### Phase 1: Hik-Connect REST API Client
**Effort: ~2 days | Risk: Low**

Implement the full REST API client for Stack A endpoints:
- Login with username + MD5(password) → sessionId + refreshSessionId
- Session refresh (PUT /v3/apigateway/login) every 30 min
- Device list with P2P/connection info
- Camera info per device
- Stream ticket + VTM info + relay server config
- Recording file list for playback
- ISAPI proxy for device configuration

Deliverable: CLI tool that logs in, lists devices, and fetches stream session parameters.

### Phase 2: VTDU Protocol Capture + Analysis
**Effort: ~1 week | Risk: High**

Capture actual VTDU protocol traffic:
1. Set up Android emulator with Hik-Connect APK
2. Configure transparent TCP proxy (mitmproxy/socat) on the emulator's gateway
3. Open live view in the app → capture TCP traffic to VTDU relay
4. Analyze binary protocol: handshake format, framing, keepalives
5. Document message types and byte layouts
6. Identify the AES encryption layer (CBC? CTR? key derivation?)

Alternative: Use Frida to hook `libezstreamclient.so` functions and log parameters + return values at each protocol step.

### Phase 3: VTDU TCP Client + Stream Proxy
**Effort: ~2 weeks | Risk: High**

Implement VTDU client in Node.js:
- TCP connection to relay server
- ECDH handshake (using the relay public key from API)
- Authentication with device serial + stream ticket
- Frame reception and reassembly
- AES decryption of video frames using device verification code
- PS demuxing → H.264/H.265 NAL units
- FFmpeg transmux to HLS segments (.ts + .m3u8)

### Phase 4: Web Frontend
**Effort: ~3 days | Risk: Low**

Next.js web app:
- Login page
- Device grid with camera thumbnails
- Live view page with HLS.js player
- Playback page with timeline scrubber
- Basic PTZ controls (via ISAPI proxy)

## Key Risks

1. **VTDU protocol is undocumented** — must be captured from traffic. If Hikvision uses certificate pinning or ECDH with no way to MITM, we may need Frida hooks on the native library instead.

2. **Stream encryption** — the device verification code (6 chars) is the AES key, but the exact KDF and mode (CBC/CTR/ECB) must be determined from traffic analysis or native library reverse engineering.

3. **Protocol changes** — Hikvision can change the VTDU protocol at any time, breaking our implementation.

4. **Rate limiting** — Hik-Connect API may rate-limit or block non-mobile clients.

## External References

- [pyEzvizApi](https://github.com/RenierM26/pyEzvizApi) — Python EZVIZ API client (98 endpoints)
- [hikconnect](https://github.com/tomasbedrich/hikconnect) — Python Hik-Connect API client
- [EZVIZ Open Platform](https://open.ys7.com/help/en/473) — Official EZVIZ developer API (alternative path if VTDU RE fails)
