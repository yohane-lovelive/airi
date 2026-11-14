import { describe, expect, it } from 'vitest'

import { regionBox, shouldCheckWatch, WATCH_LIMITS, WATCH_REGIONS } from './watch'

describe('regionBox', () => {
  it('maps each region into the frame', () => {
    expect(regionBox('full')).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect(regionBox('top-right')).toEqual({ x: 2 / 3, y: 0, width: 1 / 3, height: 1 / 3 })
    for (const region of WATCH_REGIONS) {
      const box = regionBox(region)
      expect(box.x + box.width).toBeLessThanOrEqual(1 + 1e-9)
      expect(box.y + box.height).toBeLessThanOrEqual(1 + 1e-9)
    }
  })
})

describe('shouldCheckWatch', () => {
  it('checks at once, then on a change after the minimum interval, and on the slow timer', () => {
    expect(shouldCheckWatch({ now: 0, regionChange: 0 })).toBe(true)
    expect(shouldCheckWatch({ now: WATCH_LIMITS.minCheckIntervalMs - 1, lastCheckAt: 0, regionChange: 1 })).toBe(false)
    expect(shouldCheckWatch({ now: WATCH_LIMITS.minCheckIntervalMs, lastCheckAt: 0, regionChange: WATCH_LIMITS.regionChangeDiff })).toBe(true)
    expect(shouldCheckWatch({ now: WATCH_LIMITS.minCheckIntervalMs, lastCheckAt: 0, regionChange: 0 })).toBe(false)
    expect(shouldCheckWatch({ now: WATCH_LIMITS.timerIntervalMs, lastCheckAt: 0, regionChange: 0 })).toBe(true)
  })
})
