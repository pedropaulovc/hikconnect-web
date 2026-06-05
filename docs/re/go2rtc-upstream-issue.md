# Draft: go2rtc feature issue (review before posting)

**Repo:** AlexxIT/go2rtc · **Type:** feature proposal / acceptance check
**Title:** `EZVIZ / Hik-Connect cloud P2P source (HEVC + audio, no port-forwarding)`

---

go2rtc has no cloud source for Hikvision/EZVIZ today — `isapi:` is backchannel
audio only, and the main README itself flags Hikvision's "proprietary streaming
technologies." For users whose cameras only reach the Hik-Connect cloud (no LAN,
no RTSP, no port-forwarding) there's currently no path. There's standing demand
for this: #351, #2244, #2257.

I've reverse-engineered the Hik-Connect P2P streaming protocol end to end and
implemented it as a `pkg/ezviz/` source (alias `hikconnect:`), working
credentials-only — no hardcoded keys: `login → P2P_SETUP → UDP hole-punch → SRT
→ HEVC`. The relay/VTM fallbacks aren't needed for this path.

It's complete and verified live against a real NVR, not a sketch:

- **Live video** — 4K HEVC main stream + 640×480 sub, sustained, real-time.
- **Audio** — the interleaved G.711 A-law track surfaced as a second media
  track (PCMA/8000), A/V kept in sync off a shared real-time clock.
- **Discovery** — an "EZVIZ / Hik-Connect" wizard on the Add page logs into the
  account and lists every device/channel at both `main` and `sub` as
  ready-to-add sources; same listing read-only at `GET /api/ezviz`.

It's modeled on `pkg/tutk`/`pkg/wyze` since it's the same shape: cloud lookup →
hole-punch → reorder buffer → decrypt → emit NALs. Frames hand off as whole
H.265 access units via the RAW path (`PayloadTypeRAW` + `WriteRTP`), so
`pkg/h265` does the rest. Builds/vets/race-clean, with unit tests for the V3
binary codec (byte-checked against openssl) and the Hik-RTP de-framer.

I have it ready to open as a small stacked series (data-plane source → P2P
transport → discovery). Before I send the PR: **would you accept this source?**
Two questions:

1. Scheme name — `ezviz:` or `hikconnect:` as primary (I have both aliased)?
2. Target `dev` as usual, mirroring an existing source's layout?

<details>
<summary>Protocol summary</summary>

- **Auth/config:** `POST /api/p2p/configurations` returns a per-session
  salt-indexed `P2PServerKey` (8 rotating keys; never hardcode). Login is the
  standard Hik-Connect REST flow.
- **Setup:** V3 binary protocol (TLV, custom CRC-8, AES-128-CBC). `P2P_SETUP`
  (0x0B02) → device hole-punch (0x0C00/0x0C01) → `PLAY_REQUEST` (0x0C02).
- **Transport:** device's proprietary one-way SRT dialect over UDP. Client only
  parses + ACKs (no SRT lib). Control (0x807f) and video (0x8060/0x8050) use
  separate ACK seq spaces — must be routed independently or the device
  flow-control stalls.
- **Media:** strip Hik-RTP (12B) + sub (13B) headers, reassemble RFC 7798 FUs
  (type 49) → Annex-B HEVC. Audio shares the same framing, marked by a sub-header
  byte, carrying raw G.711 A-law. Playback recordings are MPEG-PS instead.
- **Crypto:** AES-128-CBC + custom CRC-8 for the V3 protocol; HMAC-SHA256 for the
  KMS-derived inner key — all Go stdlib + `x/crypto`.
</details>
