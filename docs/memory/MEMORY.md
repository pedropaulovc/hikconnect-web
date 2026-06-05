# Memory Index

- [Greenfield main split](greenfield-main-split.md) — 2026-06-04 main reset to clean orphan slate; full RE prototype + all `docs/re/` notes below now live ONLY on branch `feat/reverse-engineering-prototype`.
- [Cloudflare access & deploy](cloudflare-access-and-deploy.md) — Worker in account 18ef…; MCP is a full superset of wrangler (write works); 10405 = wrong HTTP method (worker subdomain is POST not PUT) — check cloudflare-api__search. pedro-18e subdomain + preview-URL CI verification.

All RE project notes (paths below) live on branch `feat/reverse-engineering-prototype`, not on `main`:

- `docs/re/protocol-notes.md` — Complete P2P + VTM protocol spec (servers, keys, packet formats, ECDH)
- `docs/re/deferred-work.md` — Deferred work items for streaming implementation
- `docs/re/api-notes.md` — Hik-Connect API shapes, P2P config injection model
- `docs/re/2026-06-03-streaming-regression-investigation.md` — How streaming works credentials-only: P2PServerKey+salt fetched fresh via `POST /api/p2p/configurations` (`client.getP2PSecret()`); rotates among 8 salt-indexed keys; was the `0x101012` root cause. clientId random (not validated), userId from JWT. **§"RESOLVED (2)": intermittent stall root cause = SRT ACK pollution** — device runs two SRT sub-sessions (control `0x807f` keepalives + video) with separate seq spaces on one socket; shared `lastAckSeq` leaked control seqs into the video ACK → flow-control stall. Fixed in `handleSrtDataPacket` (route by payload type). NOT device contention (20/20 back-to-back, app force-stopped). Live + playback 4K verified, no hardcoded keys.
- [Azure deploy topology](azure-deploy-topology.md) — Deployed as a VM (host-net, instance public IP) because ACA/ACI/NAT-GW all SNAT and break P2P hole-punching. ACR + `az vm run-command` redeploy flow.
- [HEVC passthrough hvcC fix](hevc-passthrough-hvcc-fix.md) — passthrough fMP4 needs `-bsf:v hevc_metadata` or hvcC is empty and won't decode in-browser.
