# HikConnect Web

Greenfield, production-grade, **multitenant** service for streaming Hikvision
NVR/camera video over the Hik-Connect cloud (bypassing port forwarding).

`main` is a clean slate. Do not assume the prototype's structure carries over.

## Stack

Next.js 16 (App Router) on Cloudflare Workers via `@opennextjs/cloudflare`,
TypeScript strict, ESLint flat config, Vitest. Deploy/preview via Cloudflare
Workers Builds. Toolchain mirrors `../codjiflo`. Only a minimal skeleton exists
so far (`src/app`, `/api/health`) — the data model and multitenant architecture
are still being designed.

```bash
npm run dev          # next dev
npm run build:next   # next build (CI `build` check)
npm run lint:check   # eslint (CI `lint` check)
npm run typecheck    # tsc --noEmit
npm run test:coverage # vitest (CI `test` check)
npm run build        # opennextjs-cloudflare build (Workers bundle)
```

## CI / governance

- Required PR checks: **`lint`, `test`, `build`, `wait-for-deployment`,
  `e2e-tests-prod`** — keep green.
- Never commit directly to `main` (the `pre-commit` hook blocks it); open a PR.
- Merge-commits only (no squash/rebase); PRs auto-merge once required checks pass.
- The Cloudflare Worker `hikconnect-web` is live: production on
  `https://hikconnect-web.pedro-18e.workers.dev`, and each PR branch builds a
  preview version reachable at `https://<ver8>-hikconnect-web.pedro-18e.workers.dev`
  (preview URLs enabled via `workers_dev` + `preview_urls` in `wrangler.jsonc`).
  `wait-for-deployment` derives that URL from the build's Version ID and
  `e2e-tests-prod` runs Playwright against it.
- The `janitor` workflow needs a `HIKCONNECT_JANITOR_TOKEN` secret (unset).

## Reverse-engineering prototype

The full Hik-Connect P2P streaming pipeline was reverse-engineered and verified
end-to-end in a prior single-tenant prototype, preserved on branch
**`feat/reverse-engineering-prototype`**. Its `docs/re/` is the authoritative
protocol reference (P2P_SETUP, hole-punch, SRT, Hik-RTP framing, HEVC live +
MPEG-PS playback, ECDH/crypto, CAS/VTM/relay). Consult it when implementing the
production streaming path; do not re-derive what it already documents.

## Conventions

To be established as the service takes shape. Until then, follow the user's global
coding standards (flat code, early returns, enums over cross-boundary booleans, no
gratuitous backwards-compat).
