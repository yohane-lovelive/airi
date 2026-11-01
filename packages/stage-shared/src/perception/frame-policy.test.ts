import type { PolicyFrame } from './frame-policy'

import { describe, expect, it } from 'vitest'

import { pickFreshKeyframes } from './frame-policy'

/** Frames each 500 ms from time 0, each a flat screen of one brightness. Two values far apart give a large change. */
function frames(...values: number[]): PolicyFrame[] {
  return values.map((value, index) => ({ at: index * 500, thumbnail: new Uint8Array(64 * 36).fill(value) }))
}

describe('pickFreshKeyframes', () => {
  it('always picks the newest frame first, and nothing without frames or images', () => {
    expect(pickFreshKeyframes({ frames: frames(10, 10, 10), eventTimes: [], since: 0, maxImages: 1 })).toEqual([{ index: 2, role: 'newest' }])
    expect(pickFreshKeyframes({ frames: [], eventTimes: [], since: 0, maxImages: 3 })).toEqual([])
    expect(pickFreshKeyframes({ frames: frames(10), eventTimes: [], since: 0, maxImages: 0 })).toEqual([])
  })

  it('picks the frame before the change that caused an event', () => {
    // The screen jumps from 10 to 200 at index 3, and the event comes after it settles.
    const picks = pickFreshKeyframes({ frames: frames(10, 10, 10, 200, 200, 200), eventTimes: [2_000], since: -1, maxImages: 2 })

    expect(picks).toEqual([{ index: 2, role: 'before-event' }, { index: 5, role: 'newest' }])
  })

  it('fills the rest with the largest changes since the last turn, and skips frames that look the same', () => {
    const picks = pickFreshKeyframes({ frames: frames(10, 90, 90, 250, 250, 250), eventTimes: [], since: -1, maxImages: 3 })

    // Index 3 (jump of 160) looks like the newest frame, so the next pick is index 1 (jump of 80).
    expect(picks).toEqual([{ index: 1, role: 'change' }, { index: 5, role: 'newest' }])
  })

  it('ignores frames before the last turn', () => {
    const picks = pickFreshKeyframes({ frames: frames(10, 200, 10, 10), eventTimes: [], since: 1_000, maxImages: 3 })

    expect(picks).toEqual([{ index: 3, role: 'newest' }])
  })
})
