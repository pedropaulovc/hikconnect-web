import { describe, it, expect } from 'vitest'
import { formatCrumbs, type Crumb } from '../NavHeader'

describe('NavHeader breadcrumb logic', () => {
  describe('formatCrumbs', () => {
    it('returns empty array for empty crumbs', () => {
      const result = formatCrumbs([])
      expect(result).toEqual([])
    })

    it('marks single crumb as current (no href)', () => {
      const crumbs: Crumb[] = [{ label: 'Home' }]
      const result = formatCrumbs(crumbs)
      expect(result).toHaveLength(1)
      expect(result[0].isCurrent).toBe(true)
    })

    it('marks last crumb as current when it has no href', () => {
      const crumbs: Crumb[] = [
        { label: 'Home', href: '/' },
        { label: 'Devices', href: '/devices' },
        { label: 'Lobby' },
      ]
      const result = formatCrumbs(crumbs)
      expect(result[0].isCurrent).toBe(false)
      expect(result[1].isCurrent).toBe(false)
      expect(result[2].isCurrent).toBe(true)
    })

    it('crumbs with href are marked as links', () => {
      const crumbs: Crumb[] = [
        { label: 'Home', href: '/' },
        { label: 'Current' },
      ]
      const result = formatCrumbs(crumbs)
      expect(result[0].isLink).toBe(true)
      expect(result[1].isLink).toBe(false)
    })

    it('preserves all labels in order', () => {
      const crumbs: Crumb[] = [
        { label: 'Home', href: '/' },
        { label: 'Devices', href: '/devices' },
        { label: 'NVR-001' },
      ]
      const result = formatCrumbs(crumbs)
      expect(result.map(c => c.label)).toEqual(['Home', 'Devices', 'NVR-001'])
    })

    it('preserves href values', () => {
      const crumbs: Crumb[] = [
        { label: 'Home', href: '/' },
        { label: 'Devices', href: '/devices' },
        { label: 'Current' },
      ]
      const result = formatCrumbs(crumbs)
      expect(result[0].href).toBe('/')
      expect(result[1].href).toBe('/devices')
      expect(result[2].href).toBeUndefined()
    })

    it('uses › as the separator character', () => {
      const crumbs: Crumb[] = [
        { label: 'A', href: '/' },
        { label: 'B' },
      ]
      const result = formatCrumbs(crumbs)
      expect(result[0].separator).toBe('›')
      // Last crumb should have no separator
      expect(result[result.length - 1].separator).toBeUndefined()
    })
  })
})
