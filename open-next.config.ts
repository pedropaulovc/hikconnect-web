import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// Minimal OpenNext Cloudflare config: the Next.js App Router app is served by a
// full Node-compatible Worker. No incremental cache / queue overrides yet.
const config = {
  ...defineCloudflareConfig(),
  // Cloudflare Workers Builds runs `npm run build`, and our `build` script IS
  // `opennextjs-cloudflare build` — so point the INNER Next build straight at
  // `next build` to avoid infinite recursion.
  buildCommand: 'cross-env NODE_OPTIONS=--use-system-ca next build',
};

export default config;
