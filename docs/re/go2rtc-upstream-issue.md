# Draft: go2rtc feature issue (review before posting)

**Repo:** AlexxIT/go2rtc · **Type:** feature proposal / acceptance check
**Title:** `EZVIZ / Hik-Connect cloud P2P source (HEVC + audio, no port-forwarding)`

---

**The ask:** would you take an EZVIZ / Hik-Connect cloud P2P source? It's built
and verified live against a real NVR, ready to send as a small stacked series.
Two calls I'd want from you before I open it upstream:

1. Scheme name: `ezviz:` or `hikconnect:` as the primary? (both are aliased)
2. Target `dev`, laid out like an existing source?

The code is already up as draft PRs on my fork if you'd rather read it than take
my word for it:

- [#1 data-plane source](https://github.com/pedropaulovc/go2rtc/pull/1): the
  `pkg/ezviz` skeleton, codec probe, NAL handoff.
- [#2 P2P transport](https://github.com/pedropaulovc/go2rtc/pull/2): login →
  P2P_SETUP → hole-punch → SRT → HEVC. Stacked on #1.
- [#6 discovery](https://github.com/pedropaulovc/go2rtc/pull/6): the account
  device/stream wizard. Stacked on #2.

## Why

There's no cloud source for Hikvision/EZVIZ in go2rtc today. `isapi:` is
backchannel audio only, and the README itself flags Hikvision's "proprietary
streaming technologies." If a camera only reaches the Hik-Connect cloud, with no
LAN, RTSP, or port-forwarding, there's no way in. People keep asking for it:
#351, #2244, #2257.

## What it does

I reverse-engineered the Hik-Connect P2P streaming protocol end to end and wrote
it as a `pkg/ezviz/` source (aliased `hikconnect:`). It runs credentials-only,
no hardcoded keys: login → P2P_SETUP → UDP hole-punch → SRT → HEVC. The relay and
VTM fallbacks aren't needed for this path.

Verified live against a real NVR:

- Video: 4K HEVC main stream plus a 640×480 sub, sustained and real-time.
- Audio: the interleaved G.711 A-law track comes out as a second track
  (PCMA/8000), kept in sync with video off a shared real-time clock.
- Discovery: an "EZVIZ / Hik-Connect" wizard on the Add page logs into the
  account and lists every device and channel at `main` and `sub` as ready-to-add
  sources. Same listing read-only at `GET /api/ezviz`.

It's modeled on `pkg/tutk` and `pkg/wyze`, because the shape is identical: cloud
lookup, hole-punch, reorder buffer, decrypt, emit NALs. Frames hand off as whole
H.265 access units through the RAW path (`PayloadTypeRAW` + `WriteRTP`), so
`pkg/h265` does the rest. It builds, vets, and runs race-clean, with unit tests
for the V3 binary codec (byte-checked against openssl) and the Hik-RTP de-framer.

<details>
<summary>Protocol summary</summary>

- **Auth/config:** `POST /api/p2p/configurations` returns a per-session,
  salt-indexed `P2PServerKey` (8 rotating keys, never hardcoded). Login is the
  standard Hik-Connect REST flow.
- **Setup:** V3 binary protocol (TLV, custom CRC-8, AES-128-CBC). `P2P_SETUP`
  (0x0B02) → device hole-punch (0x0C00/0x0C01) → `PLAY_REQUEST` (0x0C02).
- **Transport:** the device's proprietary one-way SRT dialect over UDP. The
  client only parses and ACKs (no SRT library). Control (0x807f) and video
  (0x8060/0x8050) use separate ACK sequence spaces; route them independently or
  the device flow-control stalls.
- **Media:** strip Hik-RTP (12B) and sub (13B) headers, reassemble RFC 7798 FUs
  (type 49) into Annex-B HEVC. Audio shares the framing, marked by a sub-header
  byte, carrying raw G.711 A-law. Playback recordings come as MPEG-PS instead.
- **Crypto:** AES-128-CBC and custom CRC-8 for the V3 protocol, HMAC-SHA256 for
  the KMS-derived inner key. All Go stdlib plus `x/crypto`.
</details>
