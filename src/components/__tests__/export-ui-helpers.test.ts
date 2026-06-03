/**
 * Unit E (export-footage plan, Task 9): the pure datetime conversions behind
 * ExportPanel. These must be timezone-stable — the playback/export API treats
 * times as device wall-clock, so round-tripping through datetime-local must
 * preserve the literal components regardless of the runner's timezone.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { serverToDatetimeLocal, datetimeLocalToPlayback } from '../export-ui-helpers'

describe('serverToDatetimeLocal', () => {
  it('drops seconds for the minute-precision input value', () => {
    expect(serverToDatetimeLocal('2026-06-03T14:00:30')).toBe('2026-06-03T14:00')
  })

  it('strips a trailing Z (recording begin/end come with one)', () => {
    expect(serverToDatetimeLocal('2026-06-03T14:05:00Z')).toBe('2026-06-03T14:05')
  })

  it('accepts a space separator', () => {
    expect(serverToDatetimeLocal('2026-06-03 09:08:07')).toBe('2026-06-03T09:08')
  })

  it('returns empty string for an unparseable value', () => {
    expect(serverToDatetimeLocal('')).toBe('')
    expect(serverToDatetimeLocal('not-a-date')).toBe('')
  })
})

describe('datetimeLocalToPlayback', () => {
  it('adds :00 seconds and keeps the T separator', () => {
    expect(datetimeLocalToPlayback('2026-06-03T14:00')).toBe('2026-06-03T14:00:00')
  })

  it('preserves seconds when the input already has them', () => {
    expect(datetimeLocalToPlayback('2026-06-03T14:00:30')).toBe('2026-06-03T14:00:30')
  })

  it('never emits a Z or a space — must match the playback startTime format', () => {
    const out = datetimeLocalToPlayback('2026-06-03T23:59')
    expect(out).toBe('2026-06-03T23:59:00')
    expect(out).not.toContain('Z')
    expect(out).not.toContain(' ')
  })

  it('returns empty string for an unparseable value', () => {
    expect(datetimeLocalToPlayback('garbage')).toBe('')
  })
})

describe('round-trip is timezone-stable', () => {
  it('server → input → server preserves the wall-clock minute', () => {
    const server = '2026-06-03T14:05:00Z'
    const back = datetimeLocalToPlayback(serverToDatetimeLocal(server))
    expect(back).toBe('2026-06-03T14:05:00')
  })

  it('does not drift under a non-UTC process timezone (America/Sao_Paulo, UTC-3)', () => {
    // These helpers must treat the string literally and never route through
    // new Date()/Date.parse(); under a -03:00 zone a Date-based impl would shift
    // the displayed/exported hour. Force the zone and assert zero drift.
    const prevTz = process.env.TZ
    process.env.TZ = 'America/Sao_Paulo'
    try {
      // A value that straddles the date line under a -03:00 offset would be the
      // worst case for a Date-based impl (00:30 → previous day 21:30).
      expect(serverToDatetimeLocal('2026-06-03T00:30:00Z')).toBe('2026-06-03T00:30')
      expect(datetimeLocalToPlayback('2026-06-03T00:30')).toBe('2026-06-03T00:30:00')
      // Full round-trip preserves the exact wall-clock components.
      const back = datetimeLocalToPlayback(serverToDatetimeLocal('2026-06-03T00:30:00Z'))
      expect(back).toBe('2026-06-03T00:30:00')
    } finally {
      if (prevTz === undefined) delete process.env.TZ
      else process.env.TZ = prevTz
    }
  })

  it('preserves edited seconds end-to-end (user adjusts to a second boundary)', () => {
    // serverToDatetimeLocal drops to minutes for the input; if the user then types
    // a seconds-bearing value, datetimeLocalToPlayback must keep those seconds.
    expect(datetimeLocalToPlayback('2026-06-03T14:05:42')).toBe('2026-06-03T14:05:42')
  })

  afterAll(() => {
    // Belt-and-suspenders: ensure no TZ leakage to sibling test files.
    delete process.env.TZ
  })
})
