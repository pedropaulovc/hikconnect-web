---
name: greenfield-main-split
description: main was reset to a greenfield slate on 2026-06-04; the RE prototype + all docs live on a branch
metadata: 
  node_type: memory
  type: project
  originSessionId: 4c5b454e-46ba-45da-948f-27f814dd5d2b
---

On 2026-06-04 `main` was reset to a **clean greenfield slate** for a production-grade,
multitenant Hik-Connect streaming service. New `main` is a single orphan commit
(`28fbb31`) containing only repo plumbing (`.github`, `.gitignore`, `.gitattributes`,
`.npmrc`, `.husky/pre-commit`+`pre-push`, `eslint.config.mjs`, `tsconfig.json`) plus a
fresh `README.md` and `CLAUDE.md`. No `src/`, `scripts/`, `docs/`, or `package.json`.

The **entire reverse-engineering prototype** (full P2P streaming pipeline, all `docs/re/`
protocol notes, scripts, tests) is preserved intact on branch
**`feat/reverse-engineering-prototype`** (HEAD `597491c`, = the old main), pushed to origin.

**Why:** start the production multitenant build from a clean history instead of carrying
the single-tenant RE prototype forward.

**How to apply:** the `docs/re/*` pointers below now resolve only on
`feat/reverse-engineering-prototype`, not on `main` — read the protocol spec there. The
`~/.claude` memory symlink targets the repo's `docs/memory/`, which greenfield `main` no
longer tracks; the memory files were restored as untracked local files in the root
worktree (decide whether to re-track them on greenfield main). Carried-over `.github` CI /
eslint / tsconfig on main still reference the old Next.js app and will fail until reworked.
The `origin/main` "Protect main" ruleset (id 13975767) was toggled off/on for the
force-push and is back to `active`.

**Repo governance (applied 2026-06-04 via `../go-project/scripts/provision-repo.sh`):**
merge-only (no squash/rebase) + auto-merge + delete-branch-on-merge; "Protect main"
ruleset requires PR + status checks `lint`/`test`/`build` + copilot review +
`pr-review-gate` deployment env (reviewer = pedropaulovc) + deletion block; "Immutable
tags" ruleset on `v*`; release immutability; secret scanning + push protection; Actions
workflow perms = write + can-approve-PRs.

**CI direction:** the greenfield repo's CI structure will **match `../codjiflo`**
(Next.js-on-Cloudflare: open-next + wrangler) — files `ci-cd-main.yml`, `ci-cd-pr.yml`,
`copilot-setup-steps.yml`, `janitor.yml`, `dependabot.yml`, `copilot-instructions.md`.
The gh-aw **janitor** workflow stays (do not remove); `COPILOT_GITHUB_TOKEN` is
intentionally left unset for now. The carried-over Next.js CI + required `lint`/`test`/
`build` checks are placeholders until the new stack is scaffolded and CI is rebuilt to
codjiflo's shape.
