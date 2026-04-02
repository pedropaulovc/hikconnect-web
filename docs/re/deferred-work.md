---
name: deferred_p2p_work
description: Remaining work for P2P/VTM streaming — video verified, production hardening needed
type: project
---

## Streaming Work Status (2026-03-19)

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

### VERIFIED — Video Output (2026-03-19)

11. **~~Visual verification~~** — **CONFIRMED.** Extracted 391 NAL units from Android pcap capture (`scripts/frida/stream-capture.pcap`), decoded to 50 perfect 3840x2160 frames showing the Lobby camera. Frame matches reference screenshot. Zero FFmpeg errors.

### NAL Type 49 — SOLVED (2026-03-19)

12. **NAL type 49 = HEVC Fragmentation Unit (FU) per RFC 7798** — NOT encryption/proprietary wrapper:
    - **Structure**: `[2B PayloadHdr (type=49)] [1B FU header: S|E|FuType] [FU payload]`
    - **S=1**: start of new FU — reconstruct NAL header from PayloadHdr + FuType
    - **E=1**: end of FU — flush and emit reassembled NAL
    - **S=0,E=0**: continuation — strip 3 bytes, append FU payload
    - Large IDR frames split into ~230 FU fragments across MTU-sized packets
    - Each IDR picture has 2+ FUs (multiple slice segments: IDR type-19 + TRAIL_R type-1)
    - **AES encryption** only applies when "stream encryption" is enabled on NVR (not default)

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

- 132 tests passing, 1 skipped (Vitest)
- Clean TypeScript build
- Dead code removed from LiveStream and P2PSession
- HikRtpExtractor unit tests added
- Removed verificationCode from LiveStreamConfig and API routes (not needed for default streams)
