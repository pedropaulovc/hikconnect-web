---
name: deferred_p2p_work
description: Remaining work for P2P/VTM streaming — live video pipeline proven working
type: project
---

## Streaming Work Status (2026-03-18)

### Completed (VPS-tested)

1. **~~P2P_SETUP~~** — V3 0x0B02 with P2PServerKey. Both servers respond with 0x0B03. ✓
2. **~~Hole-punch~~** — 0x0C00 → 0x0C01 (10x). Device punches through. ✓
3. **~~PLAY_REQUEST~~** — Direct + TRANSFOR_DATA relay. Error=0, deviceSession=0x051f. ✓
4. **~~SRT handshake~~** — Induction → Conclusion with SRT_CMD_HSRSP extensions. ✓
5. **~~Video data~~** — 3800+ SRT data packets, 3.5MB. H.265 4K (3840x2160, 25fps). ✓
6. **~~HLS output~~** — 2.9MB of .ts segments (stream0: 853KB, stream1: 354KB, stream2: 1.7MB). ✓
7. **~~Playback support~~** — busType=2 with startTime/stopTime config. ✓
8. **~~Web pipeline~~** — LiveStream → HikRtpExtractor → FfmpegHlsPipe. ✓
9. **~~Public IP~~** — Auto-detect via api.ipify.org with caching. ✓

### Remaining — Production Readiness

10. **SRT session management** — Device limits concurrent P2P streams. After ~20 rapid reconnections, needs hours of cooldown. Need:
    - Clean SRT shutdown on stop() (partially implemented with type=5 packet)
    - P2P TEARDOWN (0x0C04) to explicitly release server-side session
    - Possibly add session timeout/retry logic

11. **SRT ACK refinement** — Current 10ms ACK timer works for initial burst but flow may stall. The device's SRT implementation expects specific ACK format matching Hikvision's modified SRT. Consider using `@eyevinn/srt` native bindings for production reliability.

12. **Video decryption — BLOCKED on verification code** — Video slices are AES-128-ECB encrypted with `MD5(verificationCode)`. VPS/SPS/PPS are plaintext (FFmpeg detects 3840x2160 HEVC Main). Without correct code, decoded video is gray/corrupted. Code "ABCDEF" confirmed WRONG (produces random NAL types). Need the 6-char code from device sticker or Hik-Connect app → Device Settings → Verification Code.

### Remaining — ECDH for Relay/VTM

13. **ECDH custom KDF** — Relay and VTM paths need ECDH P-256 handshake. The packet structure works (relay accepts, returns response) but the KDF uses a custom Matyas-Meyer-Oseas hash + SHA-256 DRBG (confirmed from ecdhCryption.dll RE). Relay returns error 0x2715. Need:
    - Wireshark capture of iVMS-4200 ECDH for test vectors, or
    - Precise FUN_180016730 reimplementation from Ghidra

### Remaining — Integration

14. **userId extraction** — Currently empty string. Should decode from session JWT `aud` claim.
15. **clientId from API** — Currently using captured value 0x0aed13f5. Should fetch from `/api/sdk/p2p/user/info/get` or equivalent.
16. **Stream token integration** — 20 tokens from `/api/user/token/get` are fetched but not used in PLAY_REQUEST.
17. **Multi-channel support** — Current code assumes channel 1. Need channel selection in UI.

### Code Quality

- 110 tests passing (Vitest)
- Clean TypeScript build
- Dead code removed from LiveStream and P2PSession
- HikRtpExtractor unit tests added
