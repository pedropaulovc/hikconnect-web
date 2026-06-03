import { detectionMeta, formatRelativeTime } from './detection';

describe('detectionMeta', () => {
  it('maps each detection type to a distinct label, icon and color', () => {
    const types = ['person', 'vehicle', 'motion', 'animal'] as const;
    const metas = types.map((t) => detectionMeta(t));

    expect(metas.map((m) => m.label)).toEqual(['Person', 'Vehicle', 'Motion', 'Animal']);
    expect(new Set(metas.map((m) => m.icon)).size).toBe(types.length);
    expect(metas.every((m) => typeof m.color === 'string' && m.color.length > 0)).toBe(true);
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-06-03T12:00:00Z');
  const ago = (sec: number) => new Date(now.getTime() - sec * 1000).toISOString();

  it('reports "just now" under a minute', () => {
    expect(formatRelativeTime(ago(5), now)).toBe('just now');
    expect(formatRelativeTime(ago(59), now)).toBe('just now');
  });

  it('reports minutes under an hour', () => {
    expect(formatRelativeTime(ago(60), now)).toBe('1 min ago');
    expect(formatRelativeTime(ago(45 * 60), now)).toBe('45 min ago');
  });

  it('reports hours under a day', () => {
    expect(formatRelativeTime(ago(60 * 60), now)).toBe('1 h ago');
    expect(formatRelativeTime(ago(5 * 60 * 60), now)).toBe('5 h ago');
  });

  it('reports days beyond 24 hours', () => {
    expect(formatRelativeTime(ago(24 * 60 * 60), now)).toBe('1 d ago');
    expect(formatRelativeTime(ago(3 * 24 * 60 * 60), now)).toBe('3 d ago');
  });

  it('clamps future timestamps to "just now"', () => {
    expect(formatRelativeTime(ago(-30), now)).toBe('just now');
  });
});
