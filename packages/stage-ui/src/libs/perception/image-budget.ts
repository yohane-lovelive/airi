/** Limits of the image budget. */
export const IMAGE_BUDGET_LIMITS = {
  /** The budget counts the images of this window. A rolling window keeps a burst at the top of each hour away. */
  windowMs: 60 * 60_000,
  minImagesPerHour: 0,
  maxImagesPerHour: 120,
  defaultImagesPerHour: 20,
  /** One decision turn sends at most this many frames. */
  maxImagesPerTurn: 3,
  /** Below this share of the budget left, a turn sends the newest frame only, and events push less. */
  lowShare: 0.5,
  /** Events keep at least this share of their pressure when the budget runs low. */
  minEventFactor: 0.25,
} as const

/** How much of the image budget is left at one time. */
export interface ImageBudgetState {
  /** Images sent in the last hour. */
  readonly used: number
  readonly limit: number
  readonly remaining: number
  /** The share left, from 0 to 1. A budget of 0 has nothing left. */
  readonly share: number
}

/** The send times that still count at `now`, oldest first. */
export function imagesInWindow(sentAt: readonly number[], now: number): number[] {
  return sentAt.filter(at => at > now - IMAGE_BUDGET_LIMITS.windowMs && at <= now).sort((left, right) => left - right)
}

/**
 * Reads the image budget at `now`.
 *
 * @example
 * imageBudgetState([now - 1_000, now - 2 * 60 * 60_000], 20, now)
 * // => { used: 1, limit: 20, remaining: 19, share: 0.95 }
 */
export function imageBudgetState(sentAt: readonly number[], limit: number, now: number): ImageBudgetState {
  const used = imagesInWindow(sentAt, now).length
  const remaining = Math.max(0, limit - used)
  return { used, limit, remaining, share: limit > 0 ? remaining / limit : 0 }
}

/** How many frames one decision turn can send: up to three, the newest only when the budget runs low, none when empty. */
export function imagesForTurn(budget: ImageBudgetState): number {
  if (budget.remaining <= 0)
    return 0
  if (budget.share < IMAGE_BUDGET_LIMITS.lowShare)
    return 1
  return Math.min(IMAGE_BUDGET_LIMITS.maxImagesPerTurn, budget.remaining)
}

/**
 * The share of its pressure that a screen event keeps. A low budget weakens events, so decision turns with frames come
 * less often. The budget stops the images, not the speech.
 */
export function eventPressureFactor(budget: ImageBudgetState): number {
  if (budget.share >= IMAGE_BUDGET_LIMITS.lowShare)
    return 1
  return Math.max(IMAGE_BUDGET_LIMITS.minEventFactor, budget.share / IMAGE_BUDGET_LIMITS.lowShare)
}
