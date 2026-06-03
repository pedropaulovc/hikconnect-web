/**
 * Unit C (export-footage plan, Task 5): export-helpers + jobs registry.
 *
 * Pure helpers — strong exact-value assertions. Times are device wall-clock ISO
 * (YYYY-MM-DDTHH:MM:SS, no Z). durationSeconds takes the difference of two such
 * strings, so it must be timezone-independent (both ends parse the same way) —
 * we assert deltas only, never an absolute epoch.
 */
import { describe, it, expect } from 'vitest'
import {
  durationSeconds,
  exportPercent,
  exportFilename,
} from '../export-helpers'
import {
  exportJobs,
  EXPORT_STATES,
  EXPORT_TTL_MS,
  type ExportState,
} from '../jobs'

describe('durationSeconds', () => {
  it('computes a 5-minute range as 300 s', () => {
    expect(durationSeconds('2026-06-03T14:00:00', '2026-06-03T14:05:00')).toBe(300)
  })

  it('computes a 20-second range', () => {
    expect(durationSeconds('2026-06-03T14:00:00', '2026-06-03T14:00:20')).toBe(20)
  })

  it('computes a 1-hour range as 3600 s', () => {
    expect(durationSeconds('2026-06-03T14:00:00', '2026-06-03T15:00:00')).toBe(3600)
  })

  it('crosses a day boundary correctly', () => {
    expect(durationSeconds('2026-06-03T23:59:50', '2026-06-04T00:00:10')).toBe(20)
  })

  it('is 0 for an empty (equal) range', () => {
    expect(durationSeconds('2026-06-03T14:00:00', '2026-06-03T14:00:00')).toBe(0)
  })

  it('clamps a reversed range to 0 (never negative)', () => {
    expect(durationSeconds('2026-06-03T14:05:00', '2026-06-03T14:00:00')).toBe(0)
  })
})

describe('exportPercent', () => {
  it('returns the floored percentage of the range covered', () => {
    expect(exportPercent(150, 300)).toBe(50)
  })

  it('clamps to 100 when progress exceeds the requested duration', () => {
    expect(exportPercent(600, 300)).toBe(100)
  })

  it('floors fractional percentages (does not round up)', () => {
    // 100/300 = 33.33% → 33, not 34.
    expect(exportPercent(100, 300)).toBe(33)
    // 299/300 = 99.66% → 99, must NOT prematurely report 100.
    expect(exportPercent(299, 300)).toBe(99)
  })

  it('is 0 at the start', () => {
    expect(exportPercent(0, 300)).toBe(0)
  })

  it('guards divide-by-zero: total <= 0 → 0', () => {
    expect(exportPercent(0, 0)).toBe(0)
    expect(exportPercent(10, 0)).toBe(0)
    expect(exportPercent(10, -5)).toBe(0)
  })
})

describe('exportFilename', () => {
  it('is safe and descriptive: cam<ch>_<date>_<HHMMSS>.mp4', () => {
    expect(exportFilename(1, '2026-06-03T14:00:00')).toBe('cam1_2026-06-03_140000.mp4')
  })

  it('embeds the channel number', () => {
    expect(exportFilename(7, '2026-06-03T14:00:00')).toBe('cam7_2026-06-03_140000.mp4')
  })

  it('handles a 2-digit channel', () => {
    expect(exportFilename(12, '2026-06-03T14:00:00')).toBe('cam12_2026-06-03_140000.mp4')
  })

  it('strips characters unsafe for a filename (no colons, no T separator)', () => {
    const name = exportFilename(2, '2026-06-03T09:08:07')
    expect(name).toBe('cam2_2026-06-03_090807.mp4')
    expect(name).not.toContain(':')
    expect(name).not.toContain('T')
    expect(name.endsWith('.mp4')).toBe(true)
  })
})

describe('export job registry (jobs.ts)', () => {
  it('exposes the exact set of states', () => {
    expect(EXPORT_STATES).toEqual(['running', 'done', 'error'])
  })

  it('exportJobs is a Map usable as the registry', () => {
    expect(exportJobs).toBeInstanceOf(Map)
    // Round-trips entries by id.
    const probe = { id: 'probe-1' } as { id: string }
    exportJobs.set('probe-1', probe as never)
    expect(exportJobs.get('probe-1')).toBe(probe)
    exportJobs.delete('probe-1')
    expect(exportJobs.has('probe-1')).toBe(false)
  })

  it('pins the registry to globalThis so route bundles share one Map', async () => {
    // Next.js bundles each route separately; a plain module Map would duplicate.
    // A fresh import must hand back the SAME Map instance (globalThis-pinned).
    const again = await import('../jobs')
    expect(again.exportJobs).toBe(exportJobs)
    const g = globalThis as unknown as { __hikExportJobs?: Map<string, unknown> }
    expect(g.__hikExportJobs).toBe(exportJobs)
  })

  it('defines the TTL backstop window', () => {
    expect(EXPORT_TTL_MS).toBe(60 * 60 * 1000)
  })

  it('ExportState is one of the declared states', () => {
    const s: ExportState = 'running'
    expect(EXPORT_STATES).toContain(s)
  })
})
