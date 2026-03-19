import { describe, it, expect } from 'vitest'
import { formatCrumbs, type Crumb } from '../NavHeader'

describe('NavHeader formatCrumbs — adversarial', () => {
  it('all crumbs with hrefs: none marked as current', () => {
    const crumbs: Crumb[] = [
      { label: 'Home', href: '/' },
      { label: 'Devices', href: '/devices' },
    ]
    const result = formatCrumbs(crumbs)
    expect(result.every(c => !c.isCurrent)).toBe(true)
  })

  it('single crumb with href: not marked as current', () => {
    const crumbs: Crumb[] = [{ label: 'Home', href: '/' }]
    const result = formatCrumbs(crumbs)
    expect(result[0].isCurrent).toBe(false)
    expect(result[0].isLink).toBe(true)
  })

  it('middle crumb without href is not marked current (only last is)', () => {
    const crumbs: Crumb[] = [
      { label: 'Home', href: '/' },
      { label: 'Gap' },  // no href, but not last
      { label: 'End' },  // no href, last
    ]
    const result = formatCrumbs(crumbs)
    expect(result[1].isCurrent).toBe(false)
    expect(result[2].isCurrent).toBe(true)
  })

  it('does not mutate input array', () => {
    const crumbs: Crumb[] = [
      { label: 'Home', href: '/' },
      { label: 'Current' },
    ]
    const original = JSON.parse(JSON.stringify(crumbs))
    formatCrumbs(crumbs)
    expect(crumbs).toEqual(original)
  })

  it('separator only appears between crumbs, never on last', () => {
    const crumbs: Crumb[] = [
      { label: 'A', href: '/' },
      { label: 'B', href: '/b' },
      { label: 'C', href: '/c' },
      { label: 'D' },
    ]
    const result = formatCrumbs(crumbs)
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].separator).toBe('›')
    }
    expect(result[result.length - 1].separator).toBeUndefined()
  })

  it('handles many crumbs (deep navigation)', () => {
    const crumbs: Crumb[] = Array.from({ length: 10 }, (_, i) => ({
      label: `Level ${i}`,
      href: i < 9 ? `/level-${i}` : undefined,
    }))
    const result = formatCrumbs(crumbs)
    expect(result).toHaveLength(10)
    expect(result[9].isCurrent).toBe(true)
    expect(result[8].separator).toBe('›')
  })
})
