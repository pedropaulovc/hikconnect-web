import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  // Pin the file-tracing root to this project. Without it, Next walks up to an
  // ancestor lockfile/git root (e.g. when building inside a git worktree) and
  // nests the standalone bundle under the relative subpath, so server.js ends
  // up somewhere other than .next/standalone/server.js. Pinning keeps the
  // output path identical in the worktree and in the Docker build context.
  outputFileTracingRoot: import.meta.dirname,
}

export default nextConfig
