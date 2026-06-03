# Architecture: HikConnect Web → Multitenant Cloud Service

## Context

`hikconnect-web` is a working **single-tenant prototype**: one Hik-Connect login per process,
all session state in `globalThis` maps, HLS written to `/tmp`, no database. It streams Hikvision
camera video by reverse-engineering the Hik-Connect P2P protocol (raw UDP + NAT hole-punching),
extracting HEVC, and transcoding to H.264 HLS via a spawned FFmpeg.

Goal: make it a **multitenant SaaS** where each tenant brings their own Hik-Connect account,
targeting **<~20 concurrent streams** initially, hosted on **Cloudflare where feasible, Azure for
the rest**.

This document records the recommended target architecture and the refactor needed to get there.
It is a design proposal, not yet an implementation plan with file-level diffs.

---

## The decisive constraint: what can and cannot run on Cloudflare

The streaming engine needs three capabilities Cloudflare Workers/edge **cannot** provide:

| Needs | Code today | CF Workers | CF Containers (public, GA) |
|---|---|---|---|
| Raw UDP sockets + NAT hole-punch | `dgram` in `p2p-session.ts:110`, `p2p-tunnel.ts:27`, `stun-client.ts` | ✗ no UDP | ⚠️ outbound only, undocumented for hole-punch; Worker→DO→container model fights long-lived sockets |
| Spawn FFmpeg / remux | `child_process` in `ffmpeg-pipe.ts:146` | ✗ | ✓ (CPU only) |
| GPU (NVENC) for 4K H.264 | `ffmpeg-pipe.ts:22-32` | ✗ | ✗ **no GPU instance types** (max `standard-4` = 4 vCPU / 12 GiB) |

**Verified (Jun 2026):** Cloudflare's public Containers product tops out at `standard-4`
(4 vCPU, 12 GiB, 20 GB disk) and has **no GPU SKUs** — GPUs exist only on Cloudflare's
*internal* platform (Workers AI), not opened to customers. Conclusion: **the streaming data
plane runs on Azure.** Cloudflare runs the edge/control plane, and optionally the
transcode+delivery tier via **Cloudflare Stream** (managed RTMPS/SRT ingest → ABR HLS/DASH).

### Answering "why can't I just pass through the stream?"

You largely **can now** — this is the biggest cost win. "Passthrough" is two separable costs:

- **Remux** (repackage Hikvision framing → fMP4/HLS, `ffmpeg -c copy`): *always required*
  (browsers can't read Hik-RTP/IMKH/MPEG-PS framing — see `hik-rtp.ts`, `imkh-parser.ts`),
  but it's **near-zero CPU and needs no GPU**.
- **Transcode HEVC→H.264** (the expensive, GPU-driving part): only needed for clients that
  can't decode HEVC.

As of 2025, **HEVC plays in every current major browser** (Safari 11+, Chrome 107+,
Firefox 134+ Win / 136 macOS / 137 Linux, Edge/Opera) **wherever the device has a hardware
HEVC decoder** — true for essentially all phones, Macs, and modern GPUs. So:

> **Default path = remux HEVC straight through (no transcode, no GPU).** Keep a CPU
> `libx264` 720p **fallback** only for the long tail (notably Windows desktops missing the
> HEVC Video Extensions, ancient browsers). At <20 streams this fallback is cheap CPU work;
> **no GPU VMs needed.**

This collapses the original 4K-NVENC requirement into an optional, rarely-hit fallback.

---

## Recommended architecture (hybrid: Cloudflare edge + Azure data plane)

```
                          ┌──────────────────────── CLOUDFLARE (control plane / edge) ────────────────────────┐
  Browser ── HTTPS ─────► │ Pages/Workers: Next.js UI + thin API (auth, device list, stream orchestration)     │
  (HLS.js)                │ Durable Objects: per-stream session registry + device cooldown (replaces globalThis)│
       ▲                  │ D1/KV: tenants, device ACLs, session index   •   R2: recordings + HLS origin        │
       │                  │ Secrets/KV (envelope-encrypted): per-tenant Hik-Connect creds   •   WAF / Access    │
       │ HLS (cached)     └───────────────┬──────────────────────────────────────────────────────────────────┘
       │                                  │ control: POST /streams (async → sessionId), poll, DELETE
       │                                  ▼
  ┌────┴──────────────── AZURE (streaming data plane — UDP + FFmpeg) ──────────────────────────┐
  │ Node streaming engine (Container Apps or small VMSS):                                       │
  │   P2P UDP + hole-punch + Hik-RTP/IMKH/SRT decode (existing src/lib/p2p/*)                   │
  │   → remux HEVC→fMP4/HLS  (libx264 720p fallback only when needed)                           │
  │   → write segments to R2  (or push RTMPS/SRT → Cloudflare Stream)                           │
  │ Outbound UDP/TCP to Hik-Connect P2P / relay / VTM (hole-punch works from Azure egress IP)   │
  └────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Cloudflare tier (everything except the streaming engine)
- **Frontend + thin API** on Pages/Workers: existing UI (`src/app/**`), plus the *non-streaming*
  API routes (`auth/login`, `devices`, `cameras`, `ticket`, `recordings`). These only do `fetch`
  to the Hik-Connect REST API → Workers-compatible.
- **Durable Objects** replace the in-memory `globalThis.__hikSessions` /`__hikDeviceLastStop`
  maps (`src/app/api/stream/sessions.ts:17,24`): one DO per stream session gives single-writer
  coordination, the 5 s device-cooldown logic, and a natural place to track lifecycle/health.
- **D1** (or KV): tenants, users, device→tenant ACLs, session index.
- **R2**: recordings + HLS segment origin (S3-compatible, **zero egress fees**, fronted by CF CDN).
- **Secrets**: per-tenant Hik-Connect credentials, envelope-encrypted (see Security).
- **WAF / Cloudflare Access / rate limiting** in front of both tiers.

### Azure tier (the part CF cannot run)
- **Node streaming engine** = the existing `src/lib/p2p/*`, `src/lib/p2p/live-stream.ts`,
  `src/lib/hls/ffmpeg-pipe.ts` extracted into a standalone long-running service (not Next.js
  API routes). Exposes a small HTTP control API.
- **Compute (small scale):** **Azure Container Apps** (scale-to-zero, outbound UDP fine) or a
  2-node **VM Scale Set** for the engine. **No GPU.** FFmpeg present for remux + optional
  libx264 fallback.
- **Networking:** outbound UDP/TCP to Hik-Connect works from Azure public egress; NAT
  hole-punch confirmed-compatible (prototype already works behind NAT — see CLAUDE.md NAT
  Traversal notes).
- **Output:** write fMP4/HLS to R2 (served via CF CDN), *or* push to Cloudflare Stream.

### Optional: Cloudflare Stream as the transcode+delivery tier
Stream Live ingests **RTMPS/SRT**, transcodes to an ABR ladder, delivers HLS/DASH globally,
auto-records ($5/1k min stored, $1/1k min delivered, no encode fee). If adopted, the Azure
engine just pushes the extracted stream in and Cloudflare owns ABR + CDN + DVR + player —
deleting our HLS-serving/storage code. **Caveat:** Stream documents H.264 (RTMP) ingest;
HEVC-over-SRT ingest is unconfirmed, so this may force an H.264 transcode on Azure first,
negating the passthrough win. **Recommendation: start with self-managed remux→R2→CF CDN**
(keeps HEVC passthrough, no transcode); revisit Stream if/when we want managed ABR/DVR.

---

## Codebase refactor required

1. **Split the monolith into two deployables.** Edge app (Next.js UI + thin API) vs. streaming
   engine service. The engine wraps existing `live-stream.ts` / `p2p-session.ts` / `ffmpeg-pipe.ts`.
2. **Make stream-start async** (per house rule "no HTTP call >1s"): `POST /streams` returns
   `sessionId` immediately; client polls `GET /streams/:id` until `ready` (first segment written).
   P2P handshake takes seconds, so today's synchronous `start/route.ts` must not block the edge.
3. **Replace `globalThis` state** (`sessions.ts:17,24`, `hikconnect/session.ts:35`) with Durable
   Objects (session registry + cooldown) and per-request tenant context — kills the
   "last login wins" single-tenant bug.
4. **Default transcode mode → remux/passthrough** in `ffmpeg-pipe.ts` (currently always
   transcodes); demote NVENC/libx264 to a fallback selected per client capability. Drop the
   GPU assumption.
5. **Per-tenant Hik-Connect auth:** thread a tenant identity through every Hik-Connect call
   (`client.ts` currently uses a single `sessionStore`); look up that tenant's stored creds,
   log in / refresh on demand, isolate sessions.
6. **HLS output → R2** instead of `/tmp` (`start/route.ts:39`, `[...path]/route.ts`); serve via
   CF CDN rather than the Node file route.

## Multitenancy & security (the critical decision)

- **BYO credentials model:** each tenant signs in with their own Hik-Connect account. Hik-Connect
  sessions expire, so to re-auth unattended we must **store the tenant's Hik-Connect password**.
  This is the central security liability.
- **Mitigation:** envelope encryption — per-tenant data key wrapping the credential, master key
  in **Azure Key Vault** (or Workers Secrets); decrypt only inside the Azure engine at stream
  time; never expose to the browser or edge logs. Consider scoping/rotation and at-rest audit.
- **Tenant isolation:** device→tenant ACL in D1 enforced at the edge before any engine call; a
  tenant can only start streams for devices on their own account.

## Cost & scale path
- **Small (<20 streams, recommended start):** 1–2 Azure D-series VMs *or* Container Apps
  (~$150–300/mo) + Workers Paid ($5/mo) + R2 (cheap, no egress) + optional Stream usage.
  **No GPU.**
- **Medium (hundreds):** Container Apps autoscale / AKS node pool; DO-based session registry
  already shards naturally; add Stream for ABR if client diversity grows.
- **Only if universal 4K H.264 is later mandated:** add Azure **NC-series GPU** nodes for NVENC
  — not required under the passthrough default.

## Alternatives considered

### Alternative 1 — All-Cloudflare (no Azure)
Only viable if transport switches from **direct UDP P2P → TCP-relay-only**. CPU remux removes
the GPU reason for a normal host, but the **UDP NAT hole-punch** (`p2p-session.ts`,
`p2p-tunnel.ts`, `stun-client.ts`) cannot run on Workers (no UDP) or reliably on CF Containers
(outbound-only, no guaranteed stable egress IP:port, scale-to-zero fights a minutes-long socket).
Routing exclusively over the TCP relay/VTM path (`relay-client.ts`, `vtm-client.ts`) — which
Cloudflare *can* do (Workers `connect()` / CF Containers) alongside CPU FFmpeg — would allow the
whole stack on CF Containers.
- **Cost:** abandon direct P2P (all video relays through Hikvision servers → added latency,
  possible throttling); **finish currently-incomplete code** (relay `blocked on KDF`, VTM
  `ECDH incomplete`); CF Containers cap at `standard-4` (4 vCPU) so ~20 x264-720p streams need
  several containers + per-GB egress.
- **Verdict:** highest risk, rests on unfinished code, degrades streaming quality. Only pursue
  after a spike proving relay-only streaming works from a CF Container. Not recommended.

### Alternative 2 — Full Azure (single cloud, no Cloudflare)
Everything on Azure. The streaming engine (UDP P2P + CPU remux) is **identical** to the hybrid —
this variant just swaps the Cloudflare edge/control plane for Azure-native equivalents.

| Concern | Hybrid (recommended) | Full Azure |
|---|---|---|
| Frontend + thin API | CF Pages/Workers | **Azure Static Web Apps** (Next.js) + **App Service / Container Apps** |
| Session registry + cooldown | Durable Objects | **Azure Cache for Redis** + app-level single-writer logic |
| Tenant/device metadata, ACLs | D1 / KV | **Azure Database for PostgreSQL** (or Cosmos DB) |
| HLS/recording storage | R2 (zero egress) | **Azure Blob Storage** (egress billed) |
| CDN / HLS delivery | CF CDN | **Azure Front Door** (or Azure CDN) |
| Secrets (tenant creds) | Workers Secrets / Key Vault | **Azure Key Vault** |
| WAF / edge protection | CF WAF / Access | **Front Door WAF / App Gateway** |
| Streaming engine | Azure Container Apps / VMSS | **same** — Azure Container Apps / VMSS, CPU remux |

- **Pros:** one vendor — unified billing, **Entra ID + managed identities** end-to-end
  (app→Key Vault→Blob with no shared secrets), single **VNet** so the control plane and engine
  talk privately, one observability stack (**App Insights / Azure Monitor**), no cross-cloud auth
  or egress hop, simpler ops, single data-residency boundary. No Workers/Durable Objects
  programming model to learn.
- **Cons:** loses Cloudflare's edge strengths — **R2's zero egress** is the big one: HLS delivery
  is egress-heavy, and Blob+Front Door bill per GB delivered, so delivery cost scales worse than
  the hybrid (negligible at <20 streams, material at scale). CF's global edge for UI/API latency
  and its WAF/DDoS posture are also forfeited. Must hand-roll the per-session coordination that
  Durable Objects gave for free (Redis + careful locking).
- **No managed video tier:** **Azure Media Services was retired (June 2024)**, so there is no
  Azure-native equivalent to Cloudflare Stream. You **own** packaging + delivery: engine writes
  fMP4/HLS to Blob, served via Front Door. (Removes the "Stream offload" option entirely.)
- **Still split frontend vs. engine (even on one cloud):** the hybrid's split is *forced* by
  Workers' inability to do UDP/FFmpeg; on Azure that forcing function is gone, but the split is
  still right because the real fault line is **stateless-bursty vs. stateful-long-lived**, not
  CF-vs-Azure. The frontend + thin API is stateless (pure `fetch` to Hik-Connect), scales on
  request count, redeploys constantly, and wants scale-to-zero. The engine is stateful — it holds
  long-lived UDP sockets + FFmpeg procs + `/tmp` segments per stream (`sessions.ts`,
  `live-stream.ts`), scales on concurrent-stream count, and must **not** be casually recycled
  (a restart drops every live stream → needs `min-replicas ≥ 1` + drain-on-deploy). Fusing them
  on Azure breaks three ways: (1) a UI spike or UI redeploy churns processes holding live streams;
  (2) behind a load balancer, `.m3u8`/segment + control requests must hit the exact instance
  owning that session's socket and temp files → forced sticky sessions; (3) one process can't hold
  both the frontend's scale-to-zero policy and the engine's persistent-socket policy. So keep the
  same boundary — **(Next.js UI + stateless API) | (engine + stream-control API)** — just without
  the cloud seam (same VNet, private hop). *Exception:* at <20 streams a single-VM monolith
  genuinely works as a fast first step; the cost is baked-in affinity/lifecycle coupling to
  untangle before a 2nd instance or zero-downtime UI deploys.
- **Refactor delta vs. hybrid:** same monolith-split, async stream-start, per-tenant auth, and
  remux-default work. Only the backing services change (Redis↔DO, Postgres↔D1, Blob↔R2,
  Front Door↔CF CDN). Engine code is unchanged.
- **Cost (small):** App Service/Container Apps for UI+API + 1–2 Container Apps/VMs for the engine
  + small Postgres + Redis + Blob/Front Door egress ≈ **$250–450/mo**, modestly above the hybrid
  mainly due to Postgres/Redis/Front Door baselines and Blob egress.
- **Verdict:** the right call if single-cloud simplicity, Entra/VNet integration, or data-residency
  outweigh edge-delivery cost. Otherwise the hybrid is cheaper to deliver and operationally lighter
  at the edge.

## Verification
- **Engine, isolated:** run the extracted Node engine on an Azure VM; `npx tsx scripts/test-p2p-to-ffmpeg.ts`
  (live) and `scripts/test-playback-ps.ts` (playback) must still produce valid output from Azure
  egress — confirms UDP hole-punch survives the cloud network. Reuse `scripts/diag-stream-reliability.ts`.
- **Passthrough playback:** produce remuxed HEVC fMP4/HLS and confirm playback in Safari, Chrome,
  and Firefox 137+ (HW-decode devices); confirm the libx264 fallback triggers for a no-HEVC client.
- **Multitenancy:** two tenants with different Hik-Connect accounts stream concurrently with no
  session bleed (the bug that exists today). Add a regression test around the new per-tenant
  session lookup.
- **Edge/engine contract:** `POST /streams` returns in <1s with a `sessionId`; `ready` appears
  after the first segment. Existing Vitest suite stays green; add tests for the session registry
  and async start.

## Open decisions (to confirm before implementation planning)
1. **Cloudflare Stream vs. self-managed remux→R2→CDN** — default is self-managed (preserves HEVC
   passthrough). Adopt Stream only if managed ABR/DVR is worth a likely H.264 transcode.
2. **Credential storage** — confirm comfort with storing tenants' Hik-Connect passwords
   (envelope-encrypted). If unacceptable, the service can only operate while a tenant session is
   live (no unattended reconnect) — a real product limitation.
3. **Azure compute** — Container Apps (scale-to-zero, simplest) vs. VMSS (more socket control).
