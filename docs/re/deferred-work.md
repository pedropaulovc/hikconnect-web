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

15. **ECDH for Relay/VTM** — RE COMPLETE (2026-06-04), TS impl pending. The earlier "custom MMO +
    SHA-256 DRBG KDF" guess was **wrong**: there is no secret→sessionKey KDF. `GenerateSessionKey`
    emits a *random* session key; the secret-binding is the packet crypto in `EncECDHReqPackage`
    (AES-256-ECB wrap of the random key with the shared secret + ChaCha20 body + HMAC-SHA256). All
    four primitives byte-verified vs Python. Full spec + vectors: **`docs/re/ecdh-kdf-vectors.md`**.
    - **DONE:** `crypto.ts` reimplemented to the verified construction (`generateSessionKey` random K,
      `wrapSessionKey` = AES-256-ECB(S), ChaCha20 body, HMAC-SHA256 MAC over the CRC-32 `"%u%u"`
      string) and `relay-client.ts` wired to it. Unit tests reproduce the captured ECDH/wrap/ChaCha20
      vectors byte-for-byte (`crypto-ecdh.test.ts`).
    - **RESOLVED — crypto is correct; `0x2715` is a key/provisioning mismatch, NOT a code bug.** A TS
      packet (self-consistent keypair) fed to the DLL's own server decryptor (`FUN_180003a40`, driven
      in-process via Frida) returns **rc=0**: MAC verifies, wrap → exact session key, ChaCha20 body →
      exact plaintext — so `crypto.ts` reproduces `EncECDHReqPackage` byte-for-byte. And **every** body
      shape incl. an **empty body** yields the *identical* `0x2715` (`scripts/_relay_probe.ts`), so the
      relay fails at **MAC verification before parsing the body** → the **shared secret doesn't match**:
      the API relay/VTM pubkey (`query/relay` + `streaming/vtm` both return the same key, ver 1) does
      not correspond to the relay node's private key for this device/account. Consistent with the
      device's **`vtduServerPublicKey` = all-zeros** (cloud hasn't provisioned the ECDH relay path for
      L38239367 — which is why iVMS uses P2P, never this relay, for it). **⇒ The "body content /
      `SendClnConnectReq` RE" lines below are SUPERSEDED — it is not the body.** To stream over the
      relay you need a device/account where the ECDH relay is provisioned (non-zero
      `vtduServerPublicKey`) so the API returns a relay key matching the node's private key.
    - **Capture attempts (2026-06-04, both blocked in this env):** (a) static — `OpenNetStream.dll`
      imports `ecdhCryption` by **ordinal**, and the kawaiidra MCP can't run Jython scripts / page
      imports / resolve ordinal imports, so the `EncECDHReqPackage` call site couldn't be located;
      (b) dynamic — iVMS on this device/NAT does **not** fall back to the relay when P2P is blocked
      (full + surgical STUN/P2P UDP firewall blocks both just fail the stream, no relay handshake), so
      its live `ClnConnectReq` body couldn't be captured. **Recommended:** standalone Ghidra (not the
      MCP) for the static path, OR capture on a network where iVMS naturally uses the VTM relay
      (symmetric NAT), OR experiment with body TLV tags/fields against the live relay
      (`scripts/test-relay-connect.ts`) — the crypto is correct, so only the plaintext body is wrong.
    - **RECOMMENDED PLAN (2026-06-04) — do NOT build symmetric-NAT infra first.** Both prior
      dead-ends were incidental *tooling* limits, not real walls, and the body is statically present
      in `OpenNetStream.dll` — so reuse the exact method that already cracked the crypto:
      1. **Cheap probe first (~1h, no RE):** the crypto is verified correct, so the body is probably
         close. Throw the obvious fixes at the live relay via `scripts/test-relay-connect.ts` — the
         ECDH-path body most likely needs the session JWT, `userId`, `clientId`, and stream params as
         TLVs that the `libCASClient`-derived body is missing or mis-tagging. If one shape clears
         `0x2715`, done — no Ghidra needed.
      2. **Primary if probe fails — standalone Ghidra (GUI, NOT the kawaiidra MCP) + in-process Frida
         drive.** The "imports by ordinal" wall only exists in the MCP; in the Ghidra GUI, map the
         ordinal to `EncECDHReqPackage` via `ecdhCryption.dll`'s export table, follow xrefs to its
         import thunk → that lands in `SendClnConnectReq`. Read the TLV body it assembles. Then dump
         it live by hooking/`NativeFunction`-driving that body-builder **in-process** (same trick used
         for the crypto vectors) to capture the plaintext body *before* ChaCha20 — **this never needs
         iVMS to actually relay**, which is exactly why it sidesteps the dynamic-capture dead-end.
         Diff the result against `relay-client.ts`.
      3. **Last resort — symmetric NAT.** Only if the body-builder reads live socket/session state
         that can't be synthesized in-process. It is the highest-effort, least-certain path: it rests
         on the *unverified* assumption that iVMS relays under symmetric NAT (blunt UDP firewalling
         did not). If forced down this road, prefer a **cloud NAT Gateway** (Azure/AWS — symmetric by
         definition, zero tuning) over Linux `iptables MASQUERADE --random-fully`; verify the NAT type
         with `pystun3` and confirm iVMS opens TCP to `148.153.53.29:8554` + an ECDH handshake before
         trusting it.
    - **Windows RE method** (`docs/re/2026-06-04-ivms4200-ecdh-kdf-capture-task.md`): drove the DLL's
      exported pipeline in-process via Frida `NativeFunction` (live relay handshake couldn't be forced).
    - Prior Android note (`docs/re/ecdh-frida-capture.md`): ECDH not triggered for device L38239367
      (`udpEcdh=0`, zero `vtduServerPublicKey`); Java API surface mapped.

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

- 239 tests passing, 1 skipped (Vitest)
- Clean TypeScript build
- Dead code removed from LiveStream and P2PSession
- HikRtpExtractor unit tests added
- Removed verificationCode from LiveStreamConfig and API routes (not needed for default streams)
