/**
 * Unit E (export-footage plan, Task 9): the pure datetime conversions behind
 * ExportPanel. These must be timezone-stable — the playback/export API treats
 * times as device wall-clock, so round-tripping through datetime-local must
 * preserve the literal components regardless of the runner's timezone.
 */
import { describe, it, expect } from 'vitest'
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
})
