import { describe, it, expect } from 'vitest'
import { isDeviceOnline, buildCameraLinks, buildRecordingsUrl } from '../helpers'

describe('Device helpers — adversarial', () => {
  describe('isDeviceOnline strict equality', () => {
    it('does not treat truthy values as online (status 100)', () => {
      expect(isDeviceOnline(100)).toBe(false)
    })

    it('does not treat string "1" as online (type safety)', () => {
      // Force a string through to test implementation doesn't use ==
      expect(isDeviceOnline('1' as unknown as number)).toBe(false)
    })
  })

  describe('buildCameraLinks consistency', () => {
    it('live and playback share same prefix', () => {
      const links = buildCameraLinks('ABC', 5)
      const livePrefix = links.live.replace(/\/live$/, '')
      const playbackPrefix = links.playback.replace(/\/playback$/, '')
      expect(livePrefix).toBe(playbackPrefix)
    })

    it('channel number is not zero-padded', () => {
      const links = buildCameraLinks('X', 1)
      expect(links.live).toContain('/1/')
      expect(links.live).not.toContain('/01/')
    })
  })

  describe('buildRecordingsUrl format', () => {
    it('startTime always ends with T00:00:00Z', () => {
      const url = buildRecordingsUrl('X', 1, '2026-12-31')
      const startParam = new URLSearchParams(url.split('?')[1]).get('startTime')
      expect(startParam).toBe('2026-12-31T00:00:00Z')
    })

    it('stopTime always ends with T23:59:59Z', () => {
      const url = buildRecordingsUrl('X', 1, '2026-12-31')
      const stopParam = new URLSearchParams(url.split('?')[1]).get('stopTime')
      expect(stopParam).toBe('2026-12-31T23:59:59Z')
    })

    it('path starts with /api/', () => {
      const url = buildRecordingsUrl('NVR', 2, '2026-01-01')
      expect(url).toMatch(/^\/api\//)
    })
  })
})
