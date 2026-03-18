---
name: deferred_p2p_work
description: Deferred work items for P2P/VTM streaming — updated after protocol debugging session
type: project
---

## Deferred Streaming Work (updated 2026-03-17)

### Critical — Path A: P2P (UDP)

1. **~~P2P server encryption~~** — RESOLVED. Uses P2PServerKey (not API KMS key), AES-128-CBC, correct CRC-8. Server returns SUCCESS.

2. **P2P request body token tail** — `p2p-session.ts` bytes 74-185 (112 bytes) of the request body are templated from a pcap capture. The 96-byte dynamic portion (bytes 90-185) is session-bound and will expire. Need to figure out how stream tokens from `/api/user/token/get` are transformed into these 96 bytes. The 16-byte static prefix (bytes 74-89: `b6c595bf4682311f3846e447233c6513`) may be derived from the P2PServerKey.

3. **P2PServerKey source** — Currently captured via Frida (`e4465f2d...`). Key is stable per account but NOT from the API KMS endpoint. Comes from GrayConfig via `setP2PV3ConfigInfo`. Need to find the API endpoint or derive it from existing API data.

4. **NAT traversal** — WSL blocks inbound UDP. P2P server forwards our request to device, but device can't punch back. Need to test from VPS with public IP, or include STUN-discovered address in request.

### Critical — Path B: VTM Relay (TCP)

5. **ECDH pubkey format** — `encECDHReqPackage` places 91 bytes at offset 43 (our self key). We're sending 65-byte raw EC point + 26 zeros. Should be 91-byte SPKI/DER format matching the server's key format.

6. **Session key transmission** — `GenerateSessionKey` produces 32 random bytes for ChaCha20 payload encryption. The server needs this key but it's not obviously transmitted in the packet. Either: (a) the "session key" IS the ECDH shared secret (function name is misleading), or (b) it's encrypted with the master key and placed in the 26-byte gap, or (c) there's an additional handshake step.

7. **CRC32 + HMAC format** — `ezviz_ecdh_crc32` returns CRC but doesn't write it. Two CRC32 values (header and payload) form an 8-byte input for HMAC-SHA256. Endianness (LE vs BE) and exact construction need verification.

### Important

8. **userId extraction** — `stream/start/route.ts` passes empty userId. Should decode JWT `aud` claim.

9. **Playback route** — `stream/playback/route.ts` just copies live with streamType=0. Needs playback-specific V3 commands with start/stop times.

10. **Stream token fetch** — `/api/user/token/get` returns 20 tokens. Need to integrate into the LiveStream flow (pass to P2PSession config).

### Minor

11. **HLS player element ID** — `page.tsx` uses `getElementById('hls-player')`. Breaks with multiple streams. Use React ref.

12. **Verification code UX** — Prompted via `window.prompt()`. Should store per-device in localStorage.

**Why:** Items 1-7 block video streaming. Items 8-12 are UX/completeness issues.

**How to apply:** Path A (P2P) is closest — deploy to VPS to test. Path B (VTM) needs ECDH pubkey format fix (item 5) first.
