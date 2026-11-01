import { describe, expect, it } from 'vitest'

import { eventPressureFactor, IMAGE_BUDGET_LIMITS, imageBudgetState, imagesForTurn, imagesInWindow } from './image-budget'

const NOW = 10 * 60 * 60_000
const MINUTE = 60_000

describe('image budget', () => {
  it('counts the images of the last hour only', () => {
    const sentAt = [NOW - 61 * MINUTE, NOW - 59 * MINUTE, NOW - MINUTE, NOW + MINUTE]

    expect(imagesInWindow(sentAt, NOW)).toEqual([NOW - 59 * MINUTE, NOW - MINUTE])
    expect(imageBudgetState(sentAt, 20, NOW)).toEqual({ used: 2, limit: 20, remaining: 18, share: 0.9 })
  })

  it('sends up to three frames, the newest only when the budget runs low, and none when it is empty', () => {
    const times = (count: number) => Array.from({ length: count }, (_, index) => NOW - index * MINUTE)

    expect(imagesForTurn(imageBudgetState([], 20, NOW))).toBe(IMAGE_BUDGET_LIMITS.maxImagesPerTurn)
    expect(imagesForTurn(imageBudgetState(times(18), 20, NOW))).toBe(1)
    expect(imagesForTurn(imageBudgetState(times(20), 20, NOW))).toBe(0)
    expect(imagesForTurn(imageBudgetState([], 0, NOW))).toBe(0)
    expect(imagesForTurn(imageBudgetState(times(8), 10, NOW))).toBe(1)
  })

  it('weakens screen events when the budget runs low, down to a floor', () => {
    const times = (count: number) => Array.from({ length: count }, (_, index) => NOW - index * MINUTE)

    expect(eventPressureFactor(imageBudgetState([], 20, NOW))).toBe(1)
    expect(eventPressureFactor(imageBudgetState(times(15), 20, NOW))).toBeCloseTo(0.5)
    expect(eventPressureFactor(imageBudgetState(times(20), 20, NOW))).toBe(IMAGE_BUDGET_LIMITS.minEventFactor)
  })
})
