---
name: deferred_p2p_work
description: Deferred work items for P2P/VTM streaming — updated after protocol debugging session
type: project
---

## Deferred Streaming Work (updated 2026-03-17)

### Critical — Path A: P2P (UDP)

1. **~~P2P server encryption~~** — RESOLVED. Two-layer: outer AES-128-CBC with P2PServerKey, inner AES-128-CBC with P2PLinkKey (IV="01234567"+zeros).

2. **~~P2P request body structure~~** — RESOLVED. Body is routing(11B) + tag=0x07(innerV3). Inner V3 = header + expand header (userId/clientId/channel) + encrypted PLAY_REQUEST TLVs. Now built dynamically in p2p-session.ts.

3. **~~P2PLinkKey identification~~** — RESOLVED. First 32 ASCII chars of API KMS `secretKey`. Confirmed via Frida capture of `szP2PLinkKey` from InitParam.

4. **Error 203 "Link status invalid"** — P2P server accepts our format but rejects with error 203. Likely needs CAS/STUN registration step before PLAY_REQUEST. The native app goes through `p2pnet_Init → STUN → CAS broker → SetPeerConnection` before streaming. Our code skips this and sends PLAY_REQUEST directly to the P2P server.

5. **P2PServerKey source** — Still captured via Frida (`e4465f2d...`). Stable per account, from GrayConfig. Need to find the API endpoint.

6. **clientId source** — Using hardcoded 0x0aed13f5 from capture. Comes from `CGlobalInfo::GetClientId()`. Need to find API source or derivation.

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
