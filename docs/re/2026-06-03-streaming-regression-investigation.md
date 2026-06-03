---
name: streaming-regression-2026-06-03
description: Live investigation — our P2P streaming pipeline stopped working (0x101012); official app still streams fine
type: project
---

# Streaming Regression Investigation — 2026-06-03

## ✅ RESOLVED — root cause: stale/wrong P2PServerKey. Fix: fetch it fresh per session.

**The P2PServerKey is account-level, rotates, and MUST be fetched live — never hardcoded.**
Source endpoint (reverse-engineered from the app via jadx):

```
POST https://{apiDomain}/api/p2p/configurations
headers: sessionId, clientType=55, featureCode=deadbeef
→ { serverInfos:[{ip,port}], ticket, resultCode:"0",
    secret:{ version, saltIndex, expireTime, data:"[b0,b1,...,b31]" } }
```

`secret.data` is 32 signed decimal bytes in brackets → the 32-byte P2PServerKey.
`secret.saltIndex` (0–7) + `secret.version` (saltVer) are the salt pair that tells the
P2P server **which** of its keys to decrypt with. Decoded in Java by
`AccountHandler.getP2PConfigInfo` (jadx: `com/ezplayer/common/AccountHandler.java:325`),
which strips the brackets, splits on `,`, parses 32 shorts, then calls
`EZStreamClientManager.setP2PV3ConfigInfo(short[32], saltIndex, version)`. The app caches
the result in MMKV with `expireTime`; re-fetches on expiry (random async refresh ~2 days
before). That cache is why a Frida capture can show a *different* key than the API serves now.

### The server holds 8 salt-indexed keys (key per saltIndex 0–7)
Hitting the endpoint repeatedly returns different (key, saltIndex) pairs, each stable for its
index — observed: salt7→`c031e9f5…`, salt5→`316c6ae2…`, salt3→`eb3606d2…`, salt2→`6d91c8f8…`.
The `saltIndex` we send in the V3 mask byte tells the server which key we used, so **any**
returned pair works. NOT ephemeral-random. This is the rollover mechanism
(`CGlobalInfo::Get{,Last}P2PServerKeyInfo`).

### Why we regressed
Every prior attempt hardcoded a stale key+salt (March `e4465f2d`/salt3, then Frida
`c031e9f5`/salt7). When the salt we sent didn't match the key the server expected, P2P_SETUP
came back `0x101012`. (So `0x101012` here WAS effectively "can't decrypt your setup", despite
the earlier device-offline theory — fetching a fresh matching key+salt makes it SUCCEED.)

### Fix applied
- `client.getP2PSecret()` (src/lib/hikconnect/client.ts) — fetches + decodes the secret.
- `P2PSecret` / `P2PConfigurationsResponse` types (src/lib/hikconnect/types.ts).
- V3 mask bytes (p2p-session.ts) now derived from config salt via `encodeMask()` (was
  hardcoded `0xda`/`0xde` = salt3) — so salt 2/5/7/etc. all encode correctly.
- `test-p2p-to-ffmpeg.ts` fetches key/salt/servers fresh, derives `userId` from JWT.

### Verified
Live 4K (3840×2160 HEVC, 20fps) credentials-only — overlay timestamp advances with wall clock.
Frame: `docs/re/reference-frames/lobby-live-credentials-only-2026-06-03.png`.

### clientId — NOT validated server-side
(expand-header tag 0x02): a client-side correlation id. Verified empirically: random clientId
streams fine. Now generated as a fresh random uint32 per session (`src/lib/p2p/client-id.ts`).
Not in Java InitParam (generated native-side; `BuildSendMsg` logs it as `ClientId:%d`).

---

## ✅ RESOLVED (2) — intermittency root cause: SRT ACK sequence pollution across two sub-sessions

**The intermittent "reaches `streaming` but ~0 video" failure (and its quieter sibling, "streams
~440 KB then dies at ~3 s") was an SRT flow-control bug in our own client — NOT device/session
contention.** The earlier contention/cooldown hypothesis is **DISPROVEN**.

### Disproof of contention
With the official Hik-Connect app **force-stopped** (zero competing clients), back-to-back runs
still failed ~60% (`diag-srt.ts`: 3/8 streamed). Cooldown made no difference. So nothing external
was holding the channel.

### The bug
The device multiplexes **two SRT sub-sessions onto our single UDP socket**, each with its **own
independent sequence space**:
- **control channel** — `0x807f` keepalives, low seq (e.g. ~192,006,726), ~1 packet every 3 s
- **data channel** — `0x80xx` video + `0x0100/0x0200` metadata, high seq (e.g. ~1,826,555,665)

`handleSrtDataPacket` fed a **single shared `lastAckSeq`** from *every* packet, and the 10 ms ACK
timer sends `lastAckSeq + 1` to the **data** socket. When a `0x807f` keepalive arrived it
overwrote `lastAckSeq` with a control-space sequence, so our next ACK told the device's data
sender "I've received up to ~192,006,727" — a sequence it never sent on that session. SRT treats
that as out-of-range, **stops advancing its flow-control window, and stalls**.

### Why it was intermittent (timing race)
- **Dense video:** the next video packet (within ~10–50 ms) re-corrects `lastAckSeq` before the
  device reacts → at most one bad ACK, tolerated → **healthy** full stream.
- **Sparse video / pre-video:** the bad ACK persists across many 10 ms cycles → device gives up.
  - *full stall* — a `0x807f` lands right after handshake, before video starts (the data socket's
    very first ACKs carry a control seq) → device never sends video (≤5 packets, 0 KB).
  - *partial stall* — video flows, then a lull + `0x807f` pollutes mid-stream → device stops
    (~440 KB then silence at ~3 s). This was masked by a `bytes>50KB` "success" check.

### Evidence (`scripts/diag-srt-trace.ts`, app force-stopped)
Run 1 (partial stall): video acked cleanly (`...555922→...556067`) until **`+3176ms`** when a
`0x807f` arrived and ACK #299 jumped to `ackSeq=1988906410` (control space); video dribbled to
`#423 @3949ms` then froze (ACKs stuck at `...556086` forever). Run 2 (full stall): only the IMKH
header on the data session, while the first ACKs to it carried the control seq `192006727`.

### Fix (`src/lib/p2p/p2p-session.ts`, `handleSrtDataPacket`)
Classify each SRT data packet by payload type. A `0x807f` control keepalive now **neither
advances `lastAckSeq` nor is emitted into the media pipeline** — so video-channel ACKs only ever
carry video-channel sequence numbers. One-line root-cause fix; no architectural change.

### Verified
- Unit/integration test reproducing the pollution: `p2p-session-teardown.integration.test.ts` →
  *"does not let a 0x807f control keepalive pollute the video ACK sequence"* (red before fix,
  green after). Full suite 230 passing.
- Empirical (app force-stopped): **20/20** back-to-back runs now stream the **full window**
  (~1.3–2.4 MB, lastData at 13–15 s of a 10 s hold). Before: 3/8, and the "successes" were
  partial stalls dying at ~3 s.

---

## ✅ RESOLVED (3) — intermittent video corruption: SRT delivered in arrival order, no reorder buffer

**Surfaced by the first end-to-end *web UI* demo** (prior runs were all script-based). Live video
intermittently showed a frame decode only its top-left CTUs then **gray out**, recovering at the
next keyframe (~1 frame in 6 at 720p). ACK isolation (RESOLVED 2) fixed flow-control *stalls*; it
never addressed packet *ordering*.

### Disproof of "packet loss / missing NAK" (my first hypothesis)
The live server log showed SRT sequence advancing **exactly 1:1** with received-packet count over
31 000+ packets — no loss. Per-packet instrumentation (`scripts/diag-srt-reorder.ts`, 20 s run)
confirmed: **forward-gap events == backward arrivals (46 == 46)**, max backward jump 2. Every
momentary gap is filled by a late arrival → **pure reordering, zero loss**. ~**1.4%** of video
packets arrive out of order. So NAK/retransmit is unnecessary; in-order *delivery* is the fix.

### The bug
1. UDP reorders ~1.4 % of packets on the P2P path.
2. `handleSrtDataPacket` emitted `data` in **arrival order** — no SRT receive buffer.
3. **Hik-RTP has no usable sequence**: the RTP seq field (payload bytes 2–3) is always `0x0000`
   (`first16=8060 0000 0000 0001 …`), so `HikRtpExtractor` FU reassembly cannot reorder and
   relies entirely on SRT in-order delivery.
4. One swapped packet inside a fragmented NAL (HEVC FU) → bytes transposed → corrupt slice → the
   decoder emits leading CTUs then gray; dependent P-frames stay gray until the next IDR.

### Fix (`src/lib/p2p/p2p-session.ts`, `handleSrtDataPacket`)
Added an SRT receive **reorder buffer**: `deliverInOrder` holds packets that arrive ahead of the
next-expected sequence in a `Map<seq,payload>` and releases them in order once the gap fills
(`drainReorderBuf`). Genuine loss never stalls — a 100 ms timer **or** a packet > 64 ahead calls
`advancePastGap`, skipping the missing seq. ACK tracking unchanged (still acks highest-received;
flow control is orthogonal to delivery order).

### Verified
- Tests (red before, green after): `p2p-session-teardown.integration.test.ts` §
  *"SRT receive reordering"* — re-sequences `0,2,1,3 → 0,1,2,3`, and flushes past a genuinely
  lost packet (`0,_,2,3 → 0,2,3`) instead of stalling. Full suite **232 passing**.
- End-to-end (web UI, headed browser): **16/16** frames clean over ~60 s (vs ~1-in-6 gray
  before), OSD clock advancing 10:44:57 → 10:45:59. Tooling: `scripts/diag-srt-reorder.ts`.

### Aside — resolution, and two web-UI store bugs found the same session
- "Main (4K)" on the test NVR Ch 1 decodes at **1280×720** — that channel's main stream is 720p,
  not 4K. Earlier "4K verified" notes refer to a different channel/camera.
- The UI had never streamed before; two in-memory singletons were **duplicated across Next.js
  route bundles** (login wrote one `sessionStore`, `/api/devices` read an empty other → 401; same
  latent split between `/stream/start` and `/stream/stop`). Both pinned to `globalThis`.

---

## Trigger
Asked to confirm the previously-working footage pipeline (ref frame
`docs/re/reference-frames/lobby-pcap-long-first-2026-03-19.png`) still works.
**It does not.** `scripts/test-p2p-to-ffmpeg.ts` produces **0 KB** of video.

## What still works
- **Login / session** — `pedropaulovc` → `apiius.hik-connect.com`. JWT `aud` decodes to
  `fcfaec90a55f4a61b4e7211152a2d805` = **same account/userId** as the March Frida capture.
- **Device + cameras** — `L38239367` "812 5th Ave N", 8 channels, all cameras list fine.
- **Official Android app** — opening Lobby live view shows **live 4K video right now**
  (emulator `hiktest`, app already logged in). So device + account + network path are healthy.
- **`STATUS.isEncrypt = 0`** — this device's stream encryption is OFF (the verification-code/
  decryption work is moot for this device). Cloud never returns the verification code anywhere.

## The failure
P2P_SETUP (0x0B02) and PLAY (0x0B04) to both P2P servers return:
```
cmd=0xb03  attr tag=0x2 len=4 val=00101012
cmd=0xb05  attr tag=0x2 len=4 val=00101012
```
- A **success** 0xb03 carries `tag=0xff` with the device IP:PORT sub-TLV (`tag=0x74`); we only
  get `tag=0x02` → handleSetupResponse finds no ffAttr → no pre-punch → device never sends
  0x0C00 hole-punch → 0 bytes. (see `p2p-session.ts:792`)

### 0x101012 is NOT a key error
`docs/re/protocol-notes.md:93` *guessed* "0x101012 = wrong key", but the authoritative error
table (`v3-protocol-opcodes.md:238-256`) puts all key errors in the `0x0Exx` range
(`0x0E48` key-info-mismatch, `0x0E16` decrypt-empty-key, `0x0E4C` P2P-server-decrypt-fail).
`0x101011` = **device offline (297)**; `0x101012` (298) is its sibling — a **server-side
device/P2P-availability status**, not a crypto rejection.

## P2PServerKey DID rotate (fixed, but was not the blocker)
Re-captured live via `frida -U -n Hik-Connect -l scripts/frida/get-p2p-key.js` (tap Lobby →
`createPreviewHandle` → `stP2PServerKey`):

| Field | March (stale) | 2026-06-03 (live) |
|-------|---------------|-------------------|
| szP2PKey | `e4465f2d…39d5` | `c031e9f5cde396b98d66f1432bdbae5f201f8546e3eb092e92f6c9b6ff08c4ba` |
| saltIndex | 3 | **7** |
| saltVer | 1 | 1 |
| P2PLinkKey | `6447f56b…` | `6447f56b…` (unchanged; = KMS.secretKey[:32]) |

Updated `P2P_SERVER_KEY` + added `P2P_KEY_SALT_INDEX/VER` consts in `p2p-session.ts`, and
`test-p2p-to-ffmpeg.ts`. **Re-test still returned 0x101012** with the fresh key → confirms the
key was stale (worth fixing) but is not the cause of the regression. Keys rotate server-side
(app keeps current+last via `CGlobalInfo::Get{,Last}P2PServerKeyInfo`).

## Tooling notes
- Emulator `-tcpdump /tmp/hik-emulator.pcap` is **unreliable** here: pcap stuck at ~289 KB,
  only boot-phase Google/DNS traffic, **zero Hik/P2P packets** even while the app streams 4K.
  Do NOT trust emulator -tcpdump for the P2P capture. Use a Frida `DatagramSocket.send`
  observer (non-blocking) instead — `intercept-p2p-send.js` BLOCKS sends, don't use as-is.
- frida 17.8.2; frida-server 17.8.2 x86_64 at `/data/local/tmp/frida-server` (root).
- App PID via `frida-ps -U | grep Hik-Connect`.

## Leading hypothesis
The device is registered with / reachable via a **different P2P path or server set** than the
two IPs our pagelist `getP2PConfig` returns (`52.5.124.127`, `52.203.168.207`). The official
app may use a fresher server list, a relay/VTM path, or extra setup our P2P_SETUP omits.
**Next:** Frida-capture the app's real `DatagramSocket.send` destinations + P2P_SETUP bytes
during a working live view, diff against ours.

## ⚠️ CORRECTION (2026-06-03, later): the app IS live-streaming
The "cached frame" conclusion below was **WRONG**. The video's embedded overlay reads the
**current wall-clock time and advances** (t1 `08:11:53` → t2 `08:1x:00`, screenshots 6 s apart).
The frame only *looked* static because the lobby is empty. **The device is live-streamable
right now via the official app.** Therefore the four "no traffic" measurements below were all
**measurement failures**, not real absence of traffic:
- Emulator likely has TWO NICs (`eth0` 10.0.2.15 + `wlan0` 10.0.2.16 — the DHCP socket was on
  wlan0); `-tcpdump` watched only one. → unreliable, confirmed twice.
- Frida `recvfrom`/`recvmsg` hooks missed the real stream socket (probably `recvmmsg`/`read`
  on a connected UDP socket); the `getpeername` filter logged nothing remote.
- `ss` snapshot was taken at the wrong moment / the stream socket didn't match the filter.

**Revised diagnosis:** the device streams fine for the official app, so our `0x101012` is
**our problem** — most likely we contact the wrong P2P servers (or send a stale/malformed
P2P_SETUP), NOT a device-side outage. Next: capture the app's REAL P2P endpoints via tcpdump
*inside* the emulator on all interfaces, and diff against our pagelist servers.

---
## (SUPERSEDED — see correction above) The official app is NOT live-streaming either
Four independent checks, all during an open Lobby "live view" in the emulator:
1. Emulator `-tcpdump` pcap: **no** Hik/P2P/device packets (only Google/DNS).
2. Frida native `sendto`/`recvfrom` hooks: **zero** remote datagrams.
3. Frida `sendmsg`+`getpeername(fd)`: **zero** remote IPv4 peers.
4. `ss -tun state established` on the app: only ESTAB socket is DHCP (`:68→10.0.2.2:67`);
   **no** connection to the device (`24.35.64.195`), P2P servers (`52.x`), VTM (`148.153.x`),
   or CAS (`34.194.x`).
5. Two screenshots 6 s apart: **video region byte-identical** (only the status-bar clock and
   the cloud-fed Event Messages list change). → frozen/cached preview, not a live feed.

### What 0x101012 actually tells us (key reasoning)
P2P_SETUP (0x0B02) is a **client ↔ P2P-server** exchange that happens *before* any hole-punch:
the server either returns device connection info (`tag=0xff`/`0x74`) or an error. Getting
`0x101012` here means **the P2P server cannot set up a session for device L38239367** — i.e.
the device is not currently available on those P2P servers. This is **independent of our NAT /
hole-punch ability** (the device isn't even contacted yet), so the emulator's triple-NAT does
**not** explain it.

## CONCLUSION
The streaming regression is **device-/server-side, not a bug in our client code**:
- Our P2P_SETUP is refused with `0x101012` = "device unavailable for P2P" (sibling of
  `0x101011` device-offline 297), returned by the P2P server pre-hole-punch.
- The official app in the emulator can't stream it either (cached frame, no stream traffic).
- The cloud still reports the device **online** (`status=1`) and **event/alarm** thumbnails
  flow over the cloud API — so the device's *cloud heartbeat* is alive, but its *live P2P
  streaming path* is down or routed through P2P servers other than the ones our pagelist
  (`getP2PConfig`) returns.

Side fix applied (real but orthogonal): P2PServerKey rotated `e4465f2d`→`c031e9f5`, saltIndex
`3`→`7`; updated `p2p-session.ts` + `test-p2p-to-ffmpeg.ts`.

## To disambiguate device-side vs P2P-server-discovery (needs user / real network)
- [ ] Does the camera stream on a **real phone** right now? YES → device is reachable
      somewhere → our pagelist returns wrong/stale P2P servers (our bug, fixable). NO →
      device-side issue (NVR streaming down / P2P disabled), nothing to fix in code.
- [ ] On a real phone (real network), capture the app's **actual P2P server IPs** and compare
      to our pagelist servers (`52.5.124.127`, `52.203.168.207`).
- [ ] Check the NVR: is P2P/Hik-Connect live streaming enabled & is it streamable from its own
      app, vs only heartbeat-online?

## Deferred cleanup (after root cause)
- [ ] Sweep remaining hardcoded `e4465f2d`/`saltIndex:3` in legacy scripts.
- [ ] Make key/salt env-overridable so future rotations don't need code edits.
