---
name: deferred_p2p_work
description: Deferred work items for P2P/VTM streaming — updated after P2P_SETUP breakthrough
type: project
---

## Deferred Streaming Work (updated 2026-03-18)

### Critical — Next Steps to Video

1. **Handle device 0x0C00 response** — Device sends cmd=0x0C00 (PREVIEW_RSP) with echoed session key after P2P_SETUP. Need to acknowledge this and transition to the data session phase. The device sends these repeatedly, likely expecting a response.

2. **Fix PLAY_REQUEST delivery** — PLAY_REQUEST wrapped in TRANSFOR_DATA still gets "Link status invalid" from P2P server. Three hypotheses:
   - (a) PLAY_REQUEST should be sent directly to the DEVICE (not P2P server) after P2P_SETUP establishes the tunnel
   - (b) PLAY_REQUEST needs to come from the SAME socket as the device's 0x0C00 packets (the device is already talking to us)
   - (c) The P2P server needs the PLAY_REQUEST to reference a valid deviceSessionId from a prior 0x0B05 response
   - Test by capturing the FULL emulator flow to see where PLAY_REQUEST is sent relative to device connection

3. **Data session establishment (0x7534 + 0x8000)** — After PLAY_REQUEST succeeds, exchange session setup (0x7534) and connection control (0x8000) packets with the device to establish the data channel.

4. **Video data reception** — Receive data packets (0x41ab type), reassemble fragments, pipe through IMKH parser → FFmpeg → HLS.

### Resolved

5. **~~P2P server encryption~~** — Two-layer AES-128-CBC. Outer: P2PServerKey. Inner: P2PLinkKey. IV: "01234567" + 8 zeros (universal for ALL V3 encryption).

6. **~~P2P request body structure~~** — Fully decoded. Outer: tag=0x00 serial + tag=0x07 inner V3. Inner: expand header + encrypted PLAY_REQUEST TLVs.

7. **~~P2PLinkKey identification~~** — First 32 ASCII chars of API KMS `secretKey`.

8. **~~P2P_SETUP (0x0B02)~~** — Link registration with P2P server. Uses P2PServerKey, no expand header, seq=0. Server responds 0x0B03 with device info. Device punches through and sends 0x0C00.

9. **~~AES IV discovery~~** — ALL V3 encryption uses IV = "01234567" + 8 zeros. The old "routing header" `30387e000c07050e` was actually `tag=0x00 serial` XORed with this IV.

### Important — Hardcoded Values

10. **P2PServerKey source** — Captured via Frida (`e4465f2d...`). Stable per account, from GrayConfig via `setP2PV3ConfigInfo`. Need to find the API endpoint that provides this key.

11. **clientId source** — Hardcoded 0x0aed13f5 from capture. From `CGlobalInfo::GetClientId()`. Need to find API source or derivation method.

12. **ComposeTransfor sub-TLV values** — Values 0x72=3, 0x75=1, 0x7f=0x0a captured from emulator. These may differ per NAT type or device. The 0x7f value (0x0a=10) doesn't match standard NAT types (0-8) — may be a composite or different enum.

### Important — Integration

13. **userId extraction** — `stream/start/route.ts` passes empty userId. Should decode JWT `aud` claim.

14. **LiveStream config update** — `live-stream.ts` needs p2pLinkKey, p2pKeyVersion, clientId, localPublicIp added to its config.

15. **Playback route** — `stream/playback/route.ts` needs PLAY_REQUEST with busType=2 and start/stop times.

16. **Stream token integration** — `/api/user/token/get` returns 20 tokens. Need to pass to P2PSession.

### Minor

17. **HLS player element ID** — `page.tsx` uses `getElementById`. Use React ref.

18. **Verification code UX** — `window.prompt()`. Should store per-device in localStorage.
