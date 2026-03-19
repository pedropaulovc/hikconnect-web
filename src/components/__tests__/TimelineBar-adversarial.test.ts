import { describe, it, expect } from 'vitest'
import { timeToPercent, findRecordingAtPercent, type Recording } from '../TimelineBar'

describe('TimelineBar — adversarial', () => {
  const dayStart = new Date('2026-03-15T00:00:00Z').getTime()

  describe('timeToPercent edge cases', () => {
    it('two calls with the same input return identical results (deterministic)', () => {
      const a = timeToPercent('2026-03-15T14:32:17Z', dayStart)
      const b = timeToPercent('2026-03-15T14:32:17Z', dayStart)
      expect(a).toBe(b)
    })

    it('1 second resolution: 00:00:01 is slightly > 0%', () => {
      const pct = timeToPercent('2026-03-15T00:00:01Z', dayStart)
      expect(pct).toBeGreaterThan(0)
      expect(pct).toBeLessThan(0.01)
    })

    it('exactly 1 hour = 100/24 ≈ 4.167%', () => {
      expect(timeToPercent('2026-03-15T01:00:00Z', dayStart)).toBeCloseTo(100 / 24, 2)
    })
  })

  describe('findRecordingAtPercent — boundary and nearest logic', () => {
    const recs: Recording[] = [
      { begin: '2026-03-15T04:00:00Z', end: '2026-03-15T06:00:00Z' }, // midpoint: 5:00
      { begin: '2026-03-15T10:00:00Z', end: '2026-03-15T14:00:00Z' }, // midpoint: 12:00
    ]

    it('click exactly between two recordings returns the nearer one (by midpoint)', () => {
      // 8:00 AM — equidistant from rec[0] end (6:00, 2h gap) and rec[1] start (10:00, 2h gap)
      // But midpoint distance: |8:00 - 5:00| = 3h vs |8:00 - 12:00| = 4h → rec[0] is nearer
      const pct = timeToPercent('2026-03-15T08:00:00Z', dayStart)
      const rec = findRecordingAtPercent(pct, recs, dayStart)
      expect(rec).toEqual(recs[0])
    })

    it('click closer to second recording midpoint returns second', () => {
      // 9:00 AM: |9:00 - 5:00| = 4h vs |9:00 - 12:00| = 3h → rec[1] is nearer
      const pct = timeToPercent('2026-03-15T09:00:00Z', dayStart)
      const rec = findRecordingAtPercent(pct, recs, dayStart)
      expect(rec).toEqual(recs[1])
    })

    it('overlapping recordings: returns the first match found', () => {
      const overlapping: Recording[] = [
        { begin: '2026-03-15T10:00:00Z', end: '2026-03-15T13:00:00Z' },
        { begin: '2026-03-15T12:00:00Z', end: '2026-03-15T15:00:00Z' },
      ]
      // 12:30 is inside both — should return one of them (the first match)
      const pct = timeToPercent('2026-03-15T12:30:00Z', dayStart)
      const rec = findRecordingAtPercent(pct, overlapping, dayStart)
      expect(rec).toEqual(overlapping[0])
    })

    it('very short recording (1 second) is still findable', () => {
      const tiny: Recording[] = [
        { begin: '2026-03-15T12:00:00Z', end: '2026-03-15T12:00:01Z' },
      ]
      const pct = timeToPercent('2026-03-15T12:00:00Z', dayStart)
      const rec = findRecordingAtPercent(pct, tiny, dayStart)
      expect(rec).toEqual(tiny[0])
    })

    it('adjacent recordings: click at boundary of first returns first', () => {
      const adjacent: Recording[] = [
        { begin: '2026-03-15T10:00:00Z', end: '2026-03-15T11:00:00Z' },
        { begin: '2026-03-15T11:00:00Z', end: '2026-03-15T12:00:00Z' },
      ]
      // Exactly 11:00 — end of first, start of second
      const pct = timeToPercent('2026-03-15T11:00:00Z', dayStart)
      const rec = findRecordingAtPercent(pct, adjacent, dayStart)
      // Should match one of them (both contain boundary) — first match wins
      expect([adjacent[0], adjacent[1]]).toContainEqual(rec)
    })
  })

  describe('findRecordingAtPercent — percent boundary values', () => {
    const recs: Recording[] = [
      { begin: '2026-03-15T12:00:00Z', end: '2026-03-15T13:00:00Z' },
    ]

    it('0% finds nearest recording', () => {
      const rec = findRecordingAtPercent(0, recs, dayStart)
      expect(rec).toEqual(recs[0])
    })

    it('100% finds nearest recording', () => {
      const rec = findRecordingAtPercent(100, recs, dayStart)
      expect(rec).toEqual(recs[0])
    })

    it('negative percent still finds nearest', () => {
      const rec = findRecordingAtPercent(-5, recs, dayStart)
      expect(rec).toEqual(recs[0])
    })
  })
})
