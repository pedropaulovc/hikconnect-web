---
name: hikconnect-api-and-p2p-protocol
description: Real Hik-Connect API response shapes, P2P config injection model, protocol architecture from Ghidra RE
type: project
---

## REST API (verified working, March 2026)
- **API domain:** `https://apiius.hik-connect.com` (US region, returned by login — lacks `https://` scheme, must prepend)
- **NVR:** L38239367, HNR33P8-8/D, 8 channels, firmware V4.71.106
- **VTM relay:** vtmvirginia.ezvizlife.com / 148.153.53.29:8554
- **Relay server:** 148.153.39.254:6123, EC P-256 public key (version 1)
- Field names differ from decompiled Java code — always verify against real responses

## P2P Config — IS from REST API (corrected 2026-06-03)
> Earlier note said "NOT from REST API — injected via JNI". That was wrong. The Java layer's
> `setP2PV3ConfigInfo` is fed from a REST call:
>
> **`POST https://{apiDomain}/api/p2p/configurations`** (headers: `sessionId`, `clientType=55`,
> `featureCode=deadbeef`) →
> ```json
> { "serverInfos":[{"ip":"52.5.124.127","port":6000},{"ip":"52.203.168.207","port":6000}],
>   "ticket":null, "resultCode":"0",
>   "secret":{ "version":1, "saltIndex":3, "expireTime":1781479369,
>              "data":"[-21,54,6,-46,...]" } }   // 32 signed decimal bytes = P2PServerKey
> ```
> Decoded in `client.getP2PSecret()`. The server rotates among 8 salt-indexed keys; saltIndex
> selects which. App caches it in MMKV with `expireTime` (jadx: `AccountHandler.getP2PConfigInfo`,
> Retrofit `ConfigApi.getP2PConfigInfo` → `@POST("api/p2p/configurations")`).
> This endpoint ALSO returns the P2P server list (`serverInfos`) — same as pagelist `P2P`.

- CAS server: 34.194.209.167:6500 (TCP connects OK from WSL2)
- STUN server: 43.130.155.63:6002 (times out with standard RFC 5389 — may be proprietary)
- P2P server list: `serverInfos` from `/api/p2p/configurations`, or pagelist `P2P` filter
- P2P link key: first 32 ASCII chars of pagelist KMS `secretKey`, version 101
- userId: JWT `aud` claim of sessionId (`extractUserId`); clientId: random, not validated

## Protocol Architecture (from Ghidra RE, March 2026)
- V3 binary protocol: 12-byte header (magic 0xE2), TLV attrs, CRC-8, optional AES-128-CBC
- Stream encryption: **ChaCha20** + HMAC-SHA256 (NOT AES as initially assumed)
- Key exchange: ECDH P-256 via mbedTLS
- Opcodes: 0x0C02=PLAY, 0x0C04=TEARDOWN, 0x0B02=P2P_SETUP
- CAS broker version: v2.16.2.20250108, P2P net version: 1.1.0.211018
- P2P servers receive **UDP** packets (SendP2PServerGroup), not TCP

## Key Blocker (as of 2026-03-17)
Need the P2P server list IPs to establish UDP P2P session. Options:
1. Decompile Android APK Java layer to find the P2P config API endpoint
2. Hook EZP2PServerInfo with Frida to capture IPs (requires Hetzner VM + redroid)

**Why:** Understanding the config injection model is critical — can't establish P2P without the server list IPs.
**How to apply:** When implementing P2P client, must solve the P2P server discovery first.
