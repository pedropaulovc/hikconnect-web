import { describe, it, expect } from 'vitest'
import { getHlsConfig } from '../VideoPlayer'

describe('VideoPlayer HLS config', () => {
  describe('live mode config', () => {
    it('includes liveSyncDurationCount of 3', () => {
      const config = getHlsConfig('live')
      expect(config.liveSyncDurationCount).toBe(3)
    })

    it('includes liveMaxLatencyDurationCount of 6', () => {
      const config = getHlsConfig('live')
      expect(config.liveMaxLatencyDurationCount).toBe(6)
    })
  })

  describe('playback mode config', () => {
    it('does not include liveSyncDurationCount', () => {
      const config = getHlsConfig('playback')
      expect(config).not.toHaveProperty('liveSyncDurationCount')
    })

    it('does not include liveMaxLatencyDurationCount', () => {
      const config = getHlsConfig('playback')
      expect(config).not.toHaveProperty('liveMaxLatencyDurationCount')
    })
  })

  describe('default mode', () => {
    it('defaults to live mode when mode is omitted', () => {
      const config = getHlsConfig()
      expect(config.liveSyncDurationCount).toBe(3)
      expect(config.liveMaxLatencyDurationCount).toBe(6)
    })
  })

  describe('config structure', () => {
    it('live config is a plain object (not null/undefined)', () => {
      const config = getHlsConfig('live')
      expect(config).toBeDefined()
      expect(typeof config).toBe('object')
    })

    it('playback config is a plain object (not null/undefined)', () => {
      const config = getHlsConfig('playback')
      expect(config).toBeDefined()
      expect(typeof config).toBe('object')
    })
  })
})
