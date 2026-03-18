---
name: deferred_p2p_work
description: Deferred work items for P2P/VTM streaming — updated after P2P_SETUP breakthrough
type: project
---

## Deferred Streaming Work (updated 2026-03-18, VPS-tested, video data received)

### Critical — Next Steps to Video

1. **Complete hole-punch handshake (0x0C00 → 0x0C01)** — The device sends 0x0C00 (punch request, NOT "PREVIEW_RSP" as we thought) after P2P_SETUP. The native client (`CCasP2PClient::HandlePunchReqPackage`) responds by:
   - Verifying session UUID matches
   - Adopting the device's socket if mismatch (close old, use new)
   - **Sending punch response 10 times** via `FUN_180041bb0` to device IP:port
   - Setting "p2p connection established" flag
   - **Action:** When we receive 0x0C00, send back a 0x0C01 punch response (10x) to the device's source address. The punch response is a V3 message with cmd=0x0C01, same session key.

2. **Send PLAY_REQUEST via punched socket** — After hole-punch completes (0x0C00/0x0C01 exchange), the native code (`CP2PV3Client::SendRequest`) sends PLAY_REQUEST via **two paths**:
   - Path A: Directly to device via the punched UDP socket (or SRT/UDT socket)
   - Path B: Via TRANSFOR_DATA (0x0B04) relay through P2P server
   - Response can come from either path
   - **Action:** Send PLAY_REQUEST directly to device IP:port from the 0x0C00 packet, using the same socket. Also send via TRANSFOR_DATA as fallback. Note: native code uses SRT (srt.dll) for the direct path, but raw UDP may work for initial testing.

3. **Data session may not need 0x7534/0x8000** — From iVMS-4200 RE, `StartStream` directly calls `BuildAndSendPlayRequest` with NO separate 0x7534/0x8000 step. Those packets are SRT/UDT transport layer (handled by srt.dll internally). After PLAY_REQUEST succeeds, video data should flow directly. Our `sendSessionSetup()` may be unnecessary or even harmful for the V3 path. **Test:** after fixing punch + PLAY_REQUEST, check if data flows without 0x7534.

4. **~~Video data reception~~** — RESOLVED. SRT data packets with 0x8060 Hik-RTP frames received. H.265 4K video (3840x2160) decoded. VPS-tested.

5. **Sustain SRT data flow** — SRT data arrives initially but stalls after seconds/minutes. The SRT congestion control needs proper ACK/NAK/keepalive at 10ms intervals. Options:
   - (a) Implement minimal SRT receiver (ACK every 10ms, NAK on gaps)
   - (b) Use `@eyevinn/srt` npm package (native SRT bindings)
   - Current state: handshake works, data flows briefly, then stops

6. **Wire real-time pipeline** — Once SRT flow is sustained:
   - Strip 12B Hik-RTP + 13B sub-header from 0x8060 packets
   - AES-128-ECB decrypt video slices (MD5 of verification code)
   - Prepend Annex B start codes for VPS/SPS/PPS
   - Pipe H.265 to FFmpeg → HLS → browser

### Resolved

5. **~~P2P server encryption~~** — Two-layer AES-128-CBC. Outer: P2PServerKey. Inner: P2PLinkKey. IV: "01234567" + 8 zeros (universal for ALL V3 encryption).

6. **~~P2P request body structure~~** — Fully decoded. Outer: tag=0x00 serial + tag=0x07 inner V3. Inner: expand header + encrypted PLAY_REQUEST TLVs.

7. **~~P2PLinkKey identification~~** — First 32 ASCII chars of API KMS `secretKey`.

8. **~~P2P_SETUP (0x0B02)~~** — Link registration with P2P server. Uses P2PServerKey, no expand header, seq=0. Server responds 0x0B03 with device info. Device punches through and sends 0x0C00.

9. **~~AES IV discovery~~** — ALL V3 encryption uses IV = "01234567" + 8 zeros. The old "routing header" `30387e000c07050e` was actually `tag=0x00 serial` XORed with this IV.

### Important — Hardcoded Values

10. **P2PServerKey source** — Captured via Frida (`e4465f2d...`). Stable per account. From iVMS-4200 RE: key comes from `CGlobalInfo::SetP2PV3ConfigInfo` (global config). Likely from `/api/sdk/p2p/user/info/get` or equivalent consumer endpoint. Key has 2 version bytes. Error "P2PServer KeyInfo is invalid, maybe not init KEYINFO" if not initialized.

11. **clientId source** — Hardcoded 0x0aed13f5 from capture. From iVMS-4200 RE: sent as tag `0x8C` (4B BE) in the P2P_SETUP sub-TLV container. Comes from `CGlobalInfo::GetClientId()`. Likely from `/api/sdk/p2p/user/info/get`.

12. **ComposeTransfor sub-TLV values** — **RESOLVED from iVMS-4200 RE.** Full sub-TLV structure at tag=0xFF:
    - `0x71` ('q'): client NAT type (from `CStunInfoMgr::GetClientNatType`)
    - `0x72` ('r'): protocol/relay flag
    - `0x75` ('u'): support flags
    - `0x7F`: NAT subtype / mobile network type (0x0a may mean "unknown/not applicable")
    - `0x74` ('t'): client reflexive IP:port (STUN-discovered, optional)
    - `0x73` ('s'): client local IP:port (optional)
    - `0x8C`: clientId (4B BE)

### Blocking — ECDH KDF for Relay/VTM

13. **ECDH custom KDF (ecdhCryption.dll)** — Both relay and VTM paths require ECDH P-256 handshake. The ECDH shared secret computation and packet structure work (relay server responds instead of closing), but the **key derivation function** uses a custom Matyas-Meyer-Oseas hash (FUN_180016730) that is NOT a standard algorithm. Relay returns error 0x2715 (auth/decryption failure).
    - Status: ECDH packet structure accepted, KDF produces wrong session key
    - The custom hash uses AES-256-ECB with Merkle-Damgård padding
    - Need: either exact FUN_180016730 implementation or packet capture from iVMS-4200
    - Alternative: skip relay/VTM, use P2P direct path (no ECDH needed)
    - Files: `src/lib/p2p/crypto.ts` (ecdhDeriveSessionKey), `src/lib/p2p/relay-client.ts`

### Important — Integration

13. **userId extraction** — `stream/start/route.ts` passes empty userId. Should decode JWT `aud` claim.

14. **LiveStream config update** — `live-stream.ts` needs p2pLinkKey, p2pKeyVersion, clientId, localPublicIp added to its config.

15. **Playback route** — `stream/playback/route.ts` needs PLAY_REQUEST with busType=2 and start/stop times.

16. **Stream token integration** — `/api/user/token/get` returns 20 tokens. Need to pass to P2PSession.

### Minor

17. **HLS player element ID** — `page.tsx` uses `getElementById`. Use React ref.

18. **Verification code UX** — `window.prompt()`. Should store per-device in localStorage.
