import { describe, it, expect, afterEach } from 'vitest';
import { getHealth } from './health';

describe('getHealth', () => {
  afterEach(() => {
    delete process.env.APP_COMMIT_SHA;
  });

  it('reports ok with an ISO timestamp', () => {
    const now = new Date('2026-06-04T00:00:00.000Z');
    const health = getHealth(now);
    expect(health.status).toBe('ok');
    expect(health.timestamp).toBe('2026-06-04T00:00:00.000Z');
  });

  it('reflects the build commit when set', () => {
    process.env.APP_COMMIT_SHA = 'deadbeef';
    expect(getHealth().commit).toBe('deadbeef');
  });

  it('falls back to "unknown" without a build commit', () => {
    expect(getHealth().commit).toBe('unknown');
  });
});
