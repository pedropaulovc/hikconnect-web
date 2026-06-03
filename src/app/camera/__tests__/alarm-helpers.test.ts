import { describe, it, expect } from 'vitest'
import { datetimeLocalToServer, defaultAlarmRange, eventToPlaybackWindow } from '../alarm-helpers'

describe('datetimeLocalToServer', () => {
  it('converts datetime-local to "yyyy-MM-dd HH:mm:ss"', () => {
    expect(datetimeLocalToServer('2026-06-03T13:07')).toBe('2026-06-03 13:07:00')
  })
  it('keeps seconds when present', () => {
    expect(datetimeLocalToServer('2026-06-03T13:07:42')).toBe('2026-06-03 13:07:42')
  })
})

describe('defaultAlarmRange', () => {
  it('returns a 24h window ending at now, as datetime-local strings', () => {
    const now = new Date('2026-06-03T13:00:00') // local
    const { from, to } = defaultAlarmRange(now)
    expect(to).toBe('2026-06-03T13:00')
    expect(from).toBe('2026-06-02T13:00')
  })
})

describe('eventToPlaybackWindow', () => {
  it('builds [start-preTime, start+delayTime] in playback format (T separator, no tz)', () => {
    const w = eventToPlaybackWindow({ alarmStartTimeStr: '2026-06-03 13:07:20', preTime: 5, delayTime: 25 })
    expect(w.begin).toBe('2026-06-03T13:07:15')
    expect(w.end).toBe('2026-06-03T13:07:45')
  })
  it('handles minute/hour rollover across the offsets', () => {
    const w = eventToPlaybackWindow({ alarmStartTimeStr: '2026-06-03 13:59:58', preTime: 0, delayTime: 5 })
    expect(w.end).toBe('2026-06-03T14:00:03')
  })
})
