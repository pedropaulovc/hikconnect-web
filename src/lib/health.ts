export type Health = {
  status: 'ok';
  commit: string;
  timestamp: string;
};

/**
 * Liveness payload for /api/health. `commit` is the build SHA inlined by
 * next.config.ts (APP_COMMIT_SHA); CI verifies a deployment serves the expected
 * commit by reading this field.
 */
export function getHealth(now: Date = new Date()): Health {
  return {
    status: 'ok',
    commit: process.env.APP_COMMIT_SHA ?? 'unknown',
    timestamp: now.toISOString(),
  };
}
