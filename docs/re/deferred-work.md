---
name: deferred_p2p_work
description: Remaining work for P2P/VTM streaming — video visual verification still pending
type: project
---

## Streaming Work Status (2026-03-18)

### Completed (VPS-tested)

1. **~~P2P_SETUP~~** — V3 0x0B02 with P2PServerKey. Both servers respond with 0x0B03. ✓
2. **~~Hole-punch~~** — 0x0C00 → 0x0C01 (10x). Device punches through. ✓
3. **~~PLAY_REQUEST~~** — Direct + TRANSFOR_DATA relay. Error=0, deviceSession=0x051f. ✓
4. **~~SRT handshake~~** — Induction → Conclusion with SRT_CMD_HSRSP extensions. ✓
5. **~~Video data received~~** — 3800+ SRT data packets, 3.5MB. ✓
6. **~~FFmpeg detects codec~~** — VPS/SPS/PPS parsed → HEVC Main 3840x2160 25fps. ✓
7. **~~HLS files generated~~** — .ts segments + .m3u8 playlist produced by FFmpeg. ✓
8. **~~Playback support~~** — busType=2 with startTime/stopTime config. ✓
9. **~~Web pipeline~~** — LiveStream → HikRtpExtractor → FfmpegHlsPipe. ✓
10. **~~Public IP~~** — Auto-detect via api.ipify.org with caching. ✓

### NOT YET VERIFIED

11. **Visual verification of video output** — FFmpeg produces .ts segments and reports frame counts, but nobody has actually opened a segment in a player to confirm it shows a real camera image. FFmpeg can "decode" encrypted/garbled slice data and still produce files — they'd just be gray/green/corrupted. **This is the #1 thing to verify next.**

### Video Encryption — Clarified

~~12. **Video decryption — BLOCKED on verification code**~~ — Previously assumed video slices were AES-128-ECB encrypted with `MD5(verificationCode)`. **This assumption is wrong.** iVMS-4200 and the Hik-Connect Android app both stream video using only HikConnect credentials — no verification code needed. This means either:
- Video data is **plaintext** (and our pipeline already works, just needs visual verification)
- Encryption key is derived from the **P2P session handshake** (sessionKey, P2PLinkKey, or similar), not an out-of-band code
- Encryption is an **optional device setting** ("stream encryption") that is off by default

The verification code likely only applies to local RTSP/ISAPI access or when "stream encryption" is explicitly enabled on the NVR.

### Remaining — Production Readiness

13. **SRT session management** — Device limits concurrent P2P streams. After ~20 rapid reconnections, needs hours of cooldown. Need:
    - Clean SRT shutdown on stop() (partially implemented with type=5 packet)
    - P2P TEARDOWN (0x0C04) to explicitly release server-side session
    - Possibly add session timeout/retry logic

14. **SRT ACK refinement** — Current 10ms ACK timer works for initial burst but flow may stall. The device's SRT implementation expects specific ACK format matching Hikvision's modified SRT. Consider using `@eyevinn/srt` native bindings for production reliability.

### Remaining — ECDH for Relay/VTM

15. **ECDH custom KDF** — Relay and VTM paths need ECDH P-256 handshake. The packet structure works (relay accepts, returns response) but the KDF uses a custom Matyas-Meyer-Oseas hash + SHA-256 DRBG (confirmed from ecdhCryption.dll RE). Relay returns error 0x2715. Need:
    - Wireshark capture of iVMS-4200 ECDH for test vectors, or
    - Precise FUN_180016730 reimplementation from Ghidra

### Remaining — Integration

16. **userId extraction** — Currently empty string. Should decode from session JWT `aud` claim.
17. **clientId from API** — Currently using captured value 0x0aed13f5. Should fetch from `/api/sdk/p2p/user/info/get` or equivalent.
18. **Stream token integration** — 20 tokens from `/api/user/token/get` are fetched but not used in PLAY_REQUEST.
19. **Multi-channel support** — Current code assumes channel 1. Need channel selection in UI.

### Code Quality

- 109 tests passing, 1 skipped (Vitest)
- Clean TypeScript build
- Dead code removed from LiveStream and P2PSession
- HikRtpExtractor unit tests added
- Removed verificationCode from LiveStreamConfig and API routes (not needed for default streams)
