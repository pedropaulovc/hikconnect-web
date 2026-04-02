import { describe, it, expect } from 'vitest'
import {
  isDeviceOnline,
  buildCameraLinks,
  buildRecordingsUrl,
} from '../helpers'

describe('Device page helpers', () => {
  describe('isDeviceOnline', () => {
    it('status 1 = online', () => {
      expect(isDeviceOnline(1)).toBe(true)
    })

    it('status 0 = offline', () => {
      expect(isDeviceOnline(0)).toBe(false)
    })

    it('status -1 = offline', () => {
      expect(isDeviceOnline(-1)).toBe(false)
    })

    it('status 2 = offline', () => {
      expect(isDeviceOnline(2)).toBe(false)
    })
  })

  describe('buildCameraLinks', () => {
    it('builds live view link from serial and channel', () => {
      const links = buildCameraLinks('NVR001', 2)
      expect(links.live).toBe('/camera/NVR001/2/live')
    })

    it('builds playback link from serial and channel', () => {
      const links = buildCameraLinks('NVR001', 2)
      expect(links.playback).toBe('/camera/NVR001/2/playback')
    })

    it('handles channel 1', () => {
      const links = buildCameraLinks('ABC123', 1)
      expect(links.live).toBe('/camera/ABC123/1/live')
      expect(links.playback).toBe('/camera/ABC123/1/playback')
    })

    it('handles special characters in serial (URL-safe)', () => {
      const links = buildCameraLinks('NVR-001_X', 3)
      expect(links.live).toBe('/camera/NVR-001_X/3/live')
      expect(links.playback).toBe('/camera/NVR-001_X/3/playback')
    })
  })

  describe('buildRecordingsUrl', () => {
    it('builds URL with date, serial, and channel', () => {
      const url = buildRecordingsUrl('NVR001', 1, '2026-03-15')
      expect(url).toBe(
        '/api/devices/NVR001/1/recordings?startTime=2026-03-15T00:00:00Z&stopTime=2026-03-15T23:59:59Z'
      )
    })

    it('uses correct channel number in path', () => {
      const url = buildRecordingsUrl('NVR001', 3, '2026-03-15')
      expect(url).toContain('/NVR001/3/recordings')
    })

    it('embeds the date in both startTime and stopTime', () => {
      const url = buildRecordingsUrl('X', 1, '2026-01-01')
      expect(url).toContain('startTime=2026-01-01T00:00:00Z')
      expect(url).toContain('stopTime=2026-01-01T23:59:59Z')
    })
  })
})
