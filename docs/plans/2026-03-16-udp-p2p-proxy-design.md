# Phase 3: Server-Side UDP P2P Proxy via Native FFI — Design Document

## Goal

Stream live video and playback from a Hikvision NVR (behind NAT, no port forwarding) to a web browser, by loading the proprietary `libezstreamclient.so` native library via FFI on an ARM64 VPS.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   ARM64 VPS                               │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │              Next.js App (Node.js)                  │  │
│  │                                                    │  │
│  │  Browser ←── HLS ──→ /api/stream/:serial/:ch      │  │
│  │                            │                       │  │
│  │                  ┌─────────▼──────────┐            │  │
│  │                  │  StreamManager     │            │  │
│  │                  │  (per-channel)     │            │  │
│  │                  └─────────┬──────────┘            │  │
│  │                            │ raw frames            │  │
│  │                  ┌─────────▼──────────┐            │  │
│  │                  │  FFmpeg process    │            │  │
│  │                  │  (stdin → HLS)     │            │  │
│  │                  └────────────────────┘            │  │
│  └────────────────────────────────────────────────────┘  │
│                            │                             │
│  ┌─────────────────────────▼──────────────────────────┐  │
│  │         Native Bridge (ffi-napi)                    │  │
│  │                                                    │  │
│  │  libezstreamclient.so ← runs natively on ARM64     │  │
│  │  + libPlayCtrl.so, libhpr.so, libmbedtls.so, etc  │  │
│  │                                                    │  │
│  │  initSDK() → createPreviewHandle(InitParam)        │  │
│  │  → setCallback() → setSecretKey() → startPreview() │  │
│  │                                                    │  │
│  │  Callback delivers: type + raw frame data          │  │
│  └────────────────────────────────────────────────────┘  │
│                            │                             │
│                       UDP P2P (native)                   │
│                            │                             │
└────────────────────────────┼─────────────────────────────┘
                             │
              CAS broker ────┤──── STUN server
              34.194.209.167 │     43.130.155.63
                             │
                   ┌─────────▼─────────┐
                   │  NVR (behind NAT) │
                   │  24.35.64.195     │
                   └───────────────────┘
```

## Native Libraries Required

Extracted from `config.arm64_v8a.apk`:

| Library | Size | Purpose |
|---------|------|---------|
| libc++_shared.so | 920KB | C++ stdlib |
| libhpr.so | 1.1MB | Hikvision platform runtime |
| libmbedtls.so | 119KB | TLS |
| libmbedcrypto.so | 394KB | Crypto |
| libmbedx509.so | 119KB | X.509 |
| libSystemTransform.so | 1.4MB | Data conversion |
| libNPQos.so | 2.1MB | QoS |
| libPlayCtrl.so | 7.4MB | Video decoding |
| libstunClient.so | 863KB | STUN |
| libezstreamclient.so | 7.5MB | Core streaming |
| libFormatConversion.so | 4.0MB | Format conversion |
| libencryptprotect.so | 10KB | Encryption |
| libstlport_shared.so | 588KB | STL (legacy) |

## FFI Function Signatures

From decompiled `NativeApi.java`:

```typescript
// Lifecycle
initSDK(): number
uninitSDK(): number
createPreviewHandle(initParam: Pointer): number  // returns handle
createPlaybackHandle(initParam: Pointer): number
startPreview(handle: number): number
startPlayback(handle: number, files: Pointer): void
stopPreview(handle: number): number
stopPlayback(handle: number): number
destroyClient(handle: number): number

// Configuration
setCallback(handle: number, callback: Pointer): number
setSecretKey(handle: number, key: string): void
setTokens(tokens: Pointer): number
setP2PV3ConfigInfo(data: Pointer, saltIndex: number, version: number): number
setP2PPublicParam(natType: number): void
enableStreamClientCMDEcdh(): void

// Stream callback (called by native library)
// void onDataCallBack(int dataType, byte[] data, int dataLen)
// dataType: HEADER=1, DATA=2, AUDIO=3, STREAMKEY=4, AESMD5=5, FIRST_DATA=50, END=100
```

## InitParam Structure

From Frida capture (verified real values):

```
iStreamSource: 0          // live preview
iStreamInhibit: 10        // disable DIRECT_OUTER + DIRECT_REVERSE
szDevIP: "24.35.64.195"   // NVR WAN IP
szDevLocalIP: "192.168.0.101"
iDevCmdPort: 9010
iDevStreamPort: 9020
iStreamType: 1            // sub stream
iChannelNumber: <1-8>     // camera channel
szDevSerial: "L38239367"
szClientSession: <JWT>    // from login
szCasServerIP: "34.194.209.167"
iCasServerPort: 6500
szStunIP: "43.130.155.63"
iStunPort: 6002
iVtmPort: 8554
szVtmIP: "148.153.53.29"
iP2PVersion: 3
usP2PKeyVer: 101
szP2PLinkKey: "6447f56b9e4229fb94b6f26776003e9c0"
szHardwareCode: <MD5>
szUserID: <UUID>
iClnType: 55
iStreamTimeOut: 30000
szPermanetkey: null       // set via setSecretKey("ABCDEF") after handle creation
```

## Data Flow

1. Login via REST API → sessionId, device list, P2P config
2. `initSDK()` → initialize native library
3. Build InitParam struct with device/session/P2P parameters
4. `createPreviewHandle(initParam)` → native lib connects via CAS → STUN → UDP P2P
5. `setSecretKey(handle, verificationCode)` → set AES decryption key
6. `setCallback(handle, onData)` → register frame callback
7. `startPreview(handle)` → streaming begins
8. Callback receives frames: HEADER (stream info) → FIRST_DATA → DATA (video) → AUDIO
9. Raw PS/H.264 data piped to FFmpeg stdin
10. FFmpeg outputs HLS: `.ts` segments + live `.m3u8` playlist
11. Browser fetches HLS via Next.js API routes, plays with HLS.js

## Playback Flow

Same as above but:
- `iStreamSource = 2` (local playback)
- `szStartTime` / `szStopTime` set
- `createPlaybackHandle()` instead of `createPreviewHandle()`
- Recording file list from `/v3/streaming/records` API

## Deployment

- **Platform:** ARM64 VPS (Oracle Cloud free tier: 4 ARM cores, 24GB RAM)
- **OS:** Ubuntu 24.04 ARM64
- **Runtime:** Node.js 24 + FFmpeg
- **Native libs:** Extracted from APK, placed in `/opt/hikconnect/lib/`
- **LD_LIBRARY_PATH:** Set to native lib directory
- **Process:** Next.js app with embedded FFmpeg child processes

## Key Risks

1. **JNI vs FFI gap** — the `.so` libraries are built for Android's JNI calling convention. Some functions may expect a `JNIEnv*` pointer as first argument. If so, we need a thin C shim that provides a minimal JNI environment.

2. **Android-specific dependencies** — libraries may call Android-specific functions (e.g., `__android_log_print`, property system). May need stub implementations.

3. **Callback threading** — native library creates threads for network I/O. FFI callbacks must be thread-safe and not block the Node.js event loop.

4. **Library updates** — tied to specific APK version. App updates may change the API.

## Verification Strategy

- Extract libraries → verify they load on ARM64 Linux (`ldd`, `readelf`)
- Enumerate exports → verify function signatures match decompiled code
- Call `initSDK()` → verify it returns success (0)
- Create handle with known-good InitParam → verify P2P connection establishes
- Receive callback data → verify frame types match expected sequence
- Pipe to FFmpeg → verify HLS output is playable
