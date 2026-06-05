# HikConnect Web

Greenfield, production-grade, **multitenant** service for streaming Hikvision
NVR/camera video over the Hik-Connect cloud (bypassing port forwarding).

`main` is a clean slate — architecture, stack, and data model are being designed
from scratch. Do not assume the prototype's structure carries over.

## Reverse-engineering prototype

The full Hik-Connect P2P streaming pipeline was reverse-engineered and verified
end-to-end in a prior single-tenant prototype, preserved on branch
**`feat/reverse-engineering-prototype`**. Its `docs/re/` is the authoritative
protocol reference (P2P_SETUP, hole-punch, SRT, Hik-RTP framing, HEVC live +
MPEG-PS playback, ECDH/crypto, CAS/VTM/relay). Consult it when implementing the
production streaming path; do not re-derive what it already documents.

## Carried-over scaffolding

These files were carried from the prototype as starting points and **reference the
old Next.js app — they need rework for the new stack**:

- `.github/workflows/*` — CI builds/tests the old app; will fail until rewritten.
- `eslint.config.mjs`, `tsconfig.json` — tuned for the prototype's Next.js setup.
- `.husky/pre-commit` (blocks direct commits to `main`) and `.husky/pre-push`
  (rebase-conflict check) are stack-agnostic and kept as-is.

`.gitignore`, `.gitattributes`, `.npmrc`, `.github/dependabot.yml` carry over cleanly.

## Conventions

To be established as the service takes shape. Until then, follow the user's global
coding standards (flat code, early returns, enums over cross-boundary booleans, no
gratuitous backwards-compat).
