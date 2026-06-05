import type { NextConfig } from 'next';
import { execSync } from 'node:child_process';

/**
 * Build commit SHA for /api/health. Inlined at build time via Next's `env`
 * (server-only — never read in the browser, so no NEXT_PUBLIC_ prefix).
 * Cloudflare Workers Builds provides WORKERS_CI_COMMIT_SHA; locally fall back
 * to git; 'unknown' if neither is available.
 */
function resolveCommitSha(): string {
  if (process.env.WORKERS_CI_COMMIT_SHA) return process.env.WORKERS_CI_COMMIT_SHA;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    APP_COMMIT_SHA: resolveCommitSha(),
  },
};

export default nextConfig;
