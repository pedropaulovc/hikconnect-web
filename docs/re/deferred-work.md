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

### Video Encryption — SOLVED (2026-03-18)

12. **Video decryption — IMPLEMENTED** — Reverse-engineered from `libPlayCtrl.so` (Ghidra analysis of `IDMXAESDecryptFrame`):
    - **NAL type 49** = Hikvision encrypted NAL wrapper (HEVC unspec type)
    - **Key** = `MD5(verification_code)` (e.g. MD5("ABCDEF")) → 16 bytes
    - **Mode** = AES-128-ECB, custom Hikvision implementation (`IDMX_AES_decrypt_128`)
    - **Scope** = **Per-NAL partial encryption** — only the first 16 bytes of each NAL body are encrypted (after the 2-byte HEVC NAL header). Rest is plaintext.
    - **Structure**: `[2B type-49 header] [16B AES-ECB encrypted] [plaintext rest...]`
    - Decrypted bytes contain the original NAL header + initial slice data
    - For H.264 (codec < 3): full NAL body is encrypted (different from H.265)
    - For H.265 (codec 3-6): only first 16 bytes (for performance — 4K frames are huge)
    - **Encryption types**: type 1 = AES-128, type 2/0x12 = AES-128 (via IDMX_AES_set_decrypt_key), type 3/0x13 = AES-256
    - ECDH path (udpEcdh=1) uses ChaCha20 + HMAC-SHA256 instead — not applicable for our device
    - **Implementation**: `HikRtpExtractor` now accepts optional `verificationCode` constructor param. Set `VERIFICATION_CODE=ABCDEF` env var for test scripts.

### Remaining — Production Readiness

13. **SRT session management** — Device limits concurrent P2P streams. After ~20 rapid reconnections, needs hours of cooldown. Need:
    - Clean SRT shutdown on stop() (partially implemented with type=5 packet)
    - P2P TEARDOWN (0x0C04) to explicitly release server-side session
    - Possibly add session timeout/retry logic

14. **SRT ACK refinement** — Current 10ms ACK timer works for initial burst but flow may stall. The device's SRT implementation expects specific ACK format matching Hikvision's modified SRT. Consider using `@eyevinn/srt` native bindings for production reliability.

### Remaining — ECDH for Relay/VTM

15. **ECDH custom KDF** — Relay and VTM paths need ECDH P-256 handshake. The packet structure works (relay accepts, returns response) but the KDF uses a custom Matyas-Meyer-Oseas hash + SHA-256 DRBG (confirmed from ecdhCryption.dll RE). Relay returns error 0x2715.
    - **Frida capture (2026-03-18):** See `docs/re/ecdh-frida-capture.md`. ECDH is NOT triggered for device L38239367 (`udpEcdh=0`, `vtduServerPublicKey` all zeros). Complete InitParam structure captured. The Java API surface is fully mapped: `NativeApi.generateECDHKey()`, `setClientECDHKey()`, `enableStreamClientCMDEcdh()`.
    - To get test vectors, need: (a) device with ECDH enabled, (b) ARM64 emulator for native Frida hooks, or (c) iVMS-4200 Windows with Frida hooking ecdhCryption.dll

### Remaining — Integration

16. **userId extraction** — Currently empty string. Should decode from session JWT `aud` claim.
17. **clientId from API** — Currently using captured value 0x0aed13f5. Should fetch from `/api/sdk/p2p/user/info/get` or equivalent.
18. **Stream token integration** — 20 tokens from `/api/user/token/get` are fetched but not used in PLAY_REQUEST.
19. **Multi-channel support** — Current code assumes channel 1. Need channel selection in UI.

### Code Quality

- 128 tests passing, 1 skipped (Vitest)
- Clean TypeScript build
- Dead code removed from LiveStream and P2PSession
- HikRtpExtractor unit tests added
- Removed verificationCode from LiveStreamConfig and API routes (not needed for default streams)
