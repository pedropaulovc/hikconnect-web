# Copilot / coding-agent instructions

HikConnect Web is a greenfield, production-grade, **multitenant** service for
streaming Hikvision NVR/camera video over the Hik-Connect cloud.

## Stack

- Next.js 16 (App Router) on Cloudflare Workers via `@opennextjs/cloudflare`.
- TypeScript strict, ESLint flat config, Vitest (unit + coverage).
- Deploy/preview handled by Cloudflare Workers Builds (GitHub integration).

## Workflow

- Never commit directly to `main` — open a PR (the `pre-commit` hook blocks it).
- CI required checks: `lint`, `test`, `build`. Keep them green.
- `npm run lint` / `typecheck` / `test` / `build:next` before pushing.
- Merges are merge-commits only (no squash/rebase); PRs auto-merge once the
  required checks pass and the human review gate is approved.

## Reference

The reverse-engineered Hik-Connect P2P streaming protocol (full pipeline, verified
live + playback) lives on branch `feat/reverse-engineering-prototype` — see its
`docs/re/` when implementing the production streaming path.
