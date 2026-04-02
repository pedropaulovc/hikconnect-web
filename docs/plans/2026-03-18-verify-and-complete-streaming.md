# Verify and Complete Streaming — Design

**Date:** 2026-03-18
**Goal:** Get live preview and playback working in the browser via both P2P and VTM paths.
**Approach:** Verify-first — confirm P2P output before deeper RE work.

## Context

- P2P pipeline produces HLS segments from device video data (VPS-tested)
- FFmpeg detects HEVC Main 3840x2160 from VPS/SPS/PPS headers
- **Video output has NOT been visually verified** — could be garbled slice data
- iVMS-4200 and Android app stream without verification code — encryption is optional
- Reference frame captured: `docs/re/reference-frames/lobby-live-android-2026-03-18.png`
- Full RE toolchain available: Android emulator + Frida + Ghidra + iVMS-4200

## Phase 1: Verify P2P Video Output

**Goal:** Determine if the current pipeline produces watchable video.

### Steps

1. Create VPS: `hcloud server create --name hikp2p --type cpx11 --location ash --image ubuntu-24.04 --ssh-key hikconnect`
2. Deploy code, install deps (Node.js + FFmpeg)
3. Run `test-p2p-to-ffmpeg.ts` — captures 30s of Lobby camera
4. Download a .ts segment to local machine
5. Play with ffplay/VLC, take screenshot
6. Compare side-by-side with Android reference frame
7. Cleanup VPS

### Decision Gate

- **Video is correct** → P2P live path works. Test playback (busType=2). Move to Phase 2.
- **Gray/green/garbled** → Enter debug sub-phase.

### Debug Sub-Phase (if video is corrupted)

1. Modify `test-p2p-to-ffmpeg.ts` to dump raw SRT packets to a `.bin` file (pre-extraction)
2. Run Frida `hook-extract-frames.js` on Android emulator streaming the same camera
3. Pull Frida-captured frames and compare byte-for-byte with our `HikRtpExtractor` output
4. The delta reveals: parsing bug (wrong offsets/headers) vs encryption (ciphertext)
5. If encrypted: add Frida hook to capture the decryption key the app uses — likely derived from the P2P session handshake, not the verification code
6. Fix the pipeline and re-verify on VPS

### Playback

Same P2P flow with `busType=2` + `startTime`/`stopTime`. Test after live preview works.

## Phase 2: VTM/Relay ECDH

**Goal:** Crack the ECDH KDF so VTM and relay paths work (NAT-friendly, no VPS needed).

### Steps

1. **Wireshark capture:** Run iVMS-4200, connect to VTM server (`148.153.53.29:8554`), capture the full ECDH handshake
2. **Extract test vectors:** Client hello (91B pubkey + 32B encrypted shared secret), server hello (pubkey + response body) — known input/output pairs for the KDF
3. **Ghidra:** Precise reimplementation of `FUN_180016730` (counter-mode KDF in ecdhCryption.dll). Partial implementation exists in `crypto.ts` — gap is the block function `FUN_180009cd0`
4. **Validate:** Our KDF output matches Wireshark-captured encrypted body
5. **Integrate:** Update `relay-client.ts` and `vtm-client.ts` with working ECDH

### Alternative (if no iVMS/Wireshark access)

Use Frida on Android emulator to hook native `ECDHCryption_GenerateMasterKey` and `GenerateSessionKey`, capturing inputs + outputs as test vectors.

### VTM Streaming (after ECDH works)

1. ECDH handshake with VTM server
2. Send `StreamInfoReq` (protobuf msg type 0x130) with stream URL + ticket
3. Send `StartStreamReq` (0x145)
4. Receive video data, extract frames, pipe to FFmpeg HLS
5. Verify output matches Android reference frame

## Phase 3: Production Hardening

**Goal:** Reliable, complete streaming pipeline.

1. **SRT session management** — Clean shutdown: type=5 packet + P2P TEARDOWN (0x0C04). Prevents device cooldown exhaustion after ~20 rapid reconnects.
2. **userId from JWT** — Decode session JWT `aud` claim (currently empty string)
3. **clientId from API** — Fetch from P2P config (currently hardcoded `0x0aed13f5`)
4. **Stream tokens** — Wire 20 tokens from `/api/user/token/get` into PLAY_REQUEST
5. **Multi-channel UI** — Channel selector (currently hardcoded to channel 1)
6. **Dual-path failover** — Try P2P first (if public IP available), fall back to VTM/relay

## Success Criteria

- [ ] Live preview plays in browser showing recognizable camera footage matching Android app
- [ ] Playback of recorded footage works with time range selection
- [ ] VTM path works from behind NAT (no VPS required)
- [ ] Clean session teardown — no device cooldown after normal use
