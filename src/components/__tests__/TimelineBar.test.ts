import { describe, it, expect } from 'vitest'
import {
  timeToPercent,
  findRecordingAtPercent,
  type Recording,
} from '../TimelineBar'

describe('TimelineBar — timeToPercent', () => {
  const dayStart = new Date('2026-03-15T00:00:00Z').getTime()

  it('midnight = 0%', () => {
    expect(timeToPercent('2026-03-15T00:00:00Z', dayStart)).toBeCloseTo(0, 1)
  })

  it('noon = 50%', () => {
    expect(timeToPercent('2026-03-15T12:00:00Z', dayStart)).toBeCloseTo(50, 1)
  })

  it('6am = 25%', () => {
    expect(timeToPercent('2026-03-15T06:00:00Z', dayStart)).toBeCloseTo(25, 1)
  })

  it('18:00 = 75%', () => {
    expect(timeToPercent('2026-03-15T18:00:00Z', dayStart)).toBeCloseTo(75, 1)
  })

  it('23:59:59 ≈ 100%', () => {
    const pct = timeToPercent('2026-03-15T23:59:59Z', dayStart)
    expect(pct).toBeGreaterThan(99.9)
    expect(pct).toBeLessThanOrEqual(100)
  })

  it('end of day (24:00 equivalent) = 100%', () => {
    expect(timeToPercent('2026-03-16T00:00:00Z', dayStart)).toBeCloseTo(100, 1)
  })

  it('returns 0 for times before day start', () => {
    const pct = timeToPercent('2026-03-14T23:00:00Z', dayStart)
    expect(pct).toBeLessThanOrEqual(0)
  })

  it('returns value > 100 for times after day end', () => {
    const pct = timeToPercent('2026-03-16T01:00:00Z', dayStart)
    expect(pct).toBeGreaterThan(100)
  })

  it('handles fractional hours correctly (14:30 = 60.4%)', () => {
    expect(timeToPercent('2026-03-15T14:30:00Z', dayStart)).toBeCloseTo(60.42, 0)
  })

  it('is monotonically increasing for successive times', () => {
    const times = [
      '2026-03-15T00:00:00Z',
      '2026-03-15T06:00:00Z',
      '2026-03-15T12:00:00Z',
      '2026-03-15T18:00:00Z',
      '2026-03-15T23:59:59Z',
    ]
    const percents = times.map(t => timeToPercent(t, dayStart))
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThan(percents[i - 1])
    }
  })
})

describe('TimelineBar — findRecordingAtPercent', () => {
  const dayStart = new Date('2026-03-15T00:00:00Z').getTime()

  const recordings: Recording[] = [
    { begin: '2026-03-15T02:00:00Z', end: '2026-03-15T03:00:00Z' },
    { begin: '2026-03-15T10:00:00Z', end: '2026-03-15T11:30:00Z' },
    { begin: '2026-03-15T20:00:00Z', end: '2026-03-15T21:00:00Z' },
  ]

  it('returns exact match when click falls inside a recording', () => {
    // 2:30 AM = 10.4% — inside first recording (2:00-3:00)
    const pct = timeToPercent('2026-03-15T02:30:00Z', dayStart)
    const rec = findRecordingAtPercent(pct, recordings, dayStart)
    expect(rec).toEqual(recordings[0])
  })

  it('returns exact match for second recording', () => {
    // 10:45 = inside second recording (10:00-11:30)
    const pct = timeToPercent('2026-03-15T10:45:00Z', dayStart)
    const rec = findRecordingAtPercent(pct, recordings, dayStart)
    expect(rec).toEqual(recordings[1])
  })

  it('returns nearest recording when click misses (before first)', () => {
    // 1:00 AM — before any recording, nearest is recording[0] starting at 2:00
    const pct = timeToPercent('2026-03-15T01:00:00Z', dayStart)
    const rec = findRecordingAtPercent(pct, recordings, dayStart)
    expect(rec).toEqual(recordings[0])
  })

  it('returns nearest recording when click falls between recordings', () => {
    // 6:00 AM — between rec[0] (ends 3:00) and rec[1] (starts 10:00)
    // Closer to rec[0] end (3h gap) than rec[1] start (4h gap)
    const pct = timeToPercent('2026-03-15T06:00:00Z', dayStart)
    const rec = findRecordingAtPercent(pct, recordings, dayStart)
    expect(rec).toEqual(recordings[0])
  })

  it('returns nearest recording when click is after last recording', () => {
    // 23:00 — after last recording (20:00-21:00), nearest is recording[2]
    const pct = timeToPercent('2026-03-15T23:00:00Z', dayStart)
    const rec = findRecordingAtPercent(pct, recordings, dayStart)
    expect(rec).toEqual(recordings[2])
  })

  it('returns recording at exact start boundary', () => {
    const pct = timeToPercent('2026-03-15T10:00:00Z', dayStart)
    const rec = findRecordingAtPercent(pct, recordings, dayStart)
    expect(rec).toEqual(recordings[1])
  })

  it('returns recording at exact end boundary', () => {
    const pct = timeToPercent('2026-03-15T03:00:00Z', dayStart)
    const rec = findRecordingAtPercent(pct, recordings, dayStart)
    expect(rec).toEqual(recordings[0])
  })

  it('handles single recording', () => {
    const single: Recording[] = [
      { begin: '2026-03-15T12:00:00Z', end: '2026-03-15T13:00:00Z' },
    ]
    const pct = timeToPercent('2026-03-15T00:00:00Z', dayStart)
    const rec = findRecordingAtPercent(pct, single, dayStart)
    expect(rec).toEqual(single[0])
  })

  it('handles empty recordings — returns undefined', () => {
    const pct = timeToPercent('2026-03-15T12:00:00Z', dayStart)
    const rec = findRecordingAtPercent(pct, [], dayStart)
    expect(rec).toBeUndefined()
  })
})
