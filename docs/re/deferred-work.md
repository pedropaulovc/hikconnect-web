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

13. **~~SRT session management / "needs hours of cooldown"~~** — DISPROVEN (2026-06-03). With
    the official app force-stopped, **20/20 back-to-back reconnects at zero cooldown** stream the
    full window. There is no rapid-reconnect cooldown limit; the apparent "contention" was the
    ACK-pollution bug in #14. `stop()` already sends SRT shutdown (type=5) + P2P TEARDOWN
    (0x0C04) with retries. No session-cooldown logic needed.

14. **~~SRT ACK refinement / flow stalls~~** — RESOLVED (2026-06-03). Root cause: the device
    multiplexes two SRT sub-sessions (control `0x807f` keepalives + video) with independent
    sequence spaces onto one socket, and `handleSrtDataPacket` fed a single shared `lastAckSeq`
    from both → control-channel sequences leaked into the data-session ACK → device's flow-control
    window stalled (intermittent, masked when video was dense). Fix: route by payload type so
    `0x807f` keepalives neither advance the video ACK nor enter the media pipeline. Verified 20/20
    full-window streams + live/playback 4K. No native `@eyevinn/srt` bindings needed. See
    `docs/re/2026-06-03-streaming-regression-investigation.md` § "RESOLVED (2)".

15. **~~SRT receive reordering / intermittent video corruption~~** — RESOLVED (2026-06-03).
    Surfaced by the first web-UI demo: ~1.4% of video packets arrive out of order (pure
    reordering, no loss — `scripts/diag-srt-reorder.ts`), and `handleSrtDataPacket` emitted in
    arrival order. Hik-RTP has no usable seq field (RTP seq always `0`), so FU reassembly relies
    on SRT in-order delivery → a swapped packet corrupts a fragmented NAL → frame decodes
    top-left then grays until the next IDR. Fix: SRT receive reorder buffer (`deliverInOrder`),
    with a 100ms/64-ahead flush so genuine loss never stalls. Verified 16/16 clean frames over
    ~60s. See `docs/re/2026-06-03-streaming-regression-investigation.md` § "RESOLVED (3)".

### Remaining — ECDH for Relay/VTM

15. **ECDH custom KDF** — Relay and VTM paths need ECDH P-256 handshake. The packet structure works (relay accepts, returns response) but the KDF uses a custom Matyas-Meyer-Oseas hash + SHA-256 DRBG (confirmed from ecdhCryption.dll RE). Relay returns error 0x2715.
    - **Frida capture (2026-03-18):** See `docs/re/ecdh-frida-capture.md`. ECDH is NOT triggered for device L38239367 (`udpEcdh=0`, `vtduServerPublicKey` all zeros). Complete InitParam structure captured. The Java API surface is fully mapped: `NativeApi.generateECDHKey()`, `setClientECDHKey()`, `enableStreamClientCMDEcdh()`.
    - To get test vectors, need: (a) device with ECDH enabled, (b) ARM64 emulator for native Frida hooks, or (c) iVMS-4200 Windows with Frida hooking ecdhCryption.dll

### Remaining — Integration

16. **~~userId extraction~~** — ✓ DONE. `extractUserId()` decodes the session JWT `aud` claim.
17. **~~clientId from API~~** — ✓ RESOLVED (2026-06-03). clientId is NOT validated server-side
    (verified: random values stream fine). Generated random per session via `randomClientId()`.
    No API fetch needed.
17b. **~~P2PServerKey + salt source~~** — ✓ RESOLVED (2026-06-03). Fetched fresh per session from
    `POST /api/p2p/configurations` (`client.getP2PSecret()`). Rotates server-side (8 salt-indexed
    keys). Was the streaming-regression root cause (`0x101012`). No hardcoded keys remain.
18. **Stream token integration** — 20 tokens from `/api/user/token/get` are fetched but not used in PLAY_REQUEST.
19. **Multi-channel support** — Current code assumes channel 1. Need channel selection in UI.

### Code Quality

- 132 tests passing, 1 skipped (Vitest)
- Clean TypeScript build
- Dead code removed from LiveStream and P2PSession
- HikRtpExtractor unit tests added
- Removed verificationCode from LiveStreamConfig and API routes (not needed for default streams)
