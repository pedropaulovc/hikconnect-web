---
name: cloudflare-access-and-deploy
description: "How to reach the hikconnect-web Cloudflare Worker — MCP is read-only, use wrangler OAuth for writes; account + subdomain + preview-URL setup"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 4c5b454e-46ba-45da-948f-27f814dd5d2b
---

The `hikconnect-web` Worker lives in **Pedro@vezza.com.br's account**
`18ef3246e9f36d1560485ef53889c0ab` (the Cloudflare MCP's *other* account
`d1db42c1ac42b3aee886f219b8f56e16` is vezza.dev — wrong one).

**Auth notes:**
- Cloudflare **MCP is a full superset of wrangler** for this account — it has
  write on 18ef (verified: KV create/delete, and POST worker subdomain). Pass
  `account_id: 18ef…` on every call.
- A `10405: Method not allowed for this authentication scheme` from
  `cloudflare-api__execute` means the **wrong HTTP method on the route**, not an
  auth problem. (E.g. the worker subdomain endpoint is **POST**, not PUT:
  `POST /accounts/<acct>/workers/scripts/<name>/subdomain` with
  `{enabled, previews_enabled}`. Routes only expose GET/POST/DELETE.) When
  unsure of method/body, query the spec first with `cloudflare-api__search`
  (`spec.paths[...]`) — it returns the allowed methods + request schema.
- If a GET returns `10000: Authentication error`, the MCP token needs re-auth
  (`/mcp`).
- **wrangler** (OAuth, `pedro@vezza.com.br`) also has `workers (write)` on 18ef
  if you prefer the CLI for deploys; set `CLOUDFLARE_ACCOUNT_ID=18ef…`
  (non-interactive can't pick between the two accounts otherwise). Not required —
  the MCP can do the same writes.

**Deploy/preview setup (now in repo `wrangler.jsonc` + CLAUDE.md):**
- Account workers.dev subdomain: `pedro-18e`.
- `workers_dev: true` + `preview_urls: true` enabled → production at
  `https://hikconnect-web.pedro-18e.workers.dev`; every version reachable at
  `https://<first-8-of-version-id>-hikconnect-web.pedro-18e.workers.dev`.
- The Workers Builds GitHub check summary carries `Version ID:` but **no**
  `Preview URL:` line — CI derives the preview URL from the Version ID rather
  than scraping it. PR branches build as preview *versions* (`version_upload`);
  the default branch deploys to production.
