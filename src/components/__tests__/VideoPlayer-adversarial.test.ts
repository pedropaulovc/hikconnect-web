import { describe, it, expect } from 'vitest'
import { getHlsConfig } from '../VideoPlayer'

describe('VideoPlayer HLS config — adversarial', () => {
  it('live and playback configs are different objects', () => {
    const live = getHlsConfig('live')
    const playback = getHlsConfig('playback')
    expect(live).not.toEqual(playback)
  })

  it('calling getHlsConfig twice returns fresh objects (no shared mutation)', () => {
    const a = getHlsConfig('live')
    const b = getHlsConfig('live')
    a.liveSyncDurationCount = 999
    expect(b.liveSyncDurationCount).toBe(3)
  })

  it('playback config does not leak live-specific keys', () => {
    const config = getHlsConfig('playback')
    const keys = Object.keys(config)
    expect(keys).not.toContain('liveSyncDurationCount')
    expect(keys).not.toContain('liveMaxLatencyDurationCount')
  })

  it('live config values are numbers, not strings', () => {
    const config = getHlsConfig('live')
    expect(typeof config.liveSyncDurationCount).toBe('number')
    expect(typeof config.liveMaxLatencyDurationCount).toBe('number')
  })

  it('does not include unexpected keys in live config', () => {
    const config = getHlsConfig('live')
    const allowed = new Set(['liveSyncDurationCount', 'liveMaxLatencyDurationCount', 'enableWorker'])
    for (const key of Object.keys(config)) {
      expect(allowed.has(key)).toBe(true)
    }
  })
})
