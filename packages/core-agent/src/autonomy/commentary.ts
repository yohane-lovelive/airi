/** Pace and interruption rules of commentary. */
export const COMMENTARY_LIMITS = {
  /** On a still screen, the boredom interval of commentary grows to this multiple. */
  calmIntervalFactor: 2,
  /** On a screen that moves fully, the boredom interval shrinks to this multiple. */
  activeIntervalFactor: 0.5,
  /** An event needs at least this salience to interrupt the current line. */
  minInterruptSalience: 0.8,
  /** An interrupting event must have at least this much more salience than the event that started the current line. */
  interruptMargin: 0.3,
  /** An event with this salience or more stops the line at once. A smaller one lets the current sentence end. */
  hardInterruptSalience: 0.95,
  /** No other interruption comes for this time after one. */
  interruptCooldownMs: 15_000,
} as const

/**
 * The multiplier of the commentary interval at a screen activity from 0 to 1. A calm scene can stay quiet for long, and
 * an active scene gets more lines.
 *
 * @example
 * commentaryIntervalFactor(0)
 * // => 2
 * commentaryIntervalFactor(1)
 * // => 0.5
 */
export function commentaryIntervalFactor(activity: number): number {
  const level = Math.min(1, Math.max(0, activity))
  const { calmIntervalFactor, activeIntervalFactor } = COMMENTARY_LIMITS
  return calmIntervalFactor + (activeIntervalFactor - calmIntervalFactor) * level
}

/**
 * What a new event does to the line that plays now.
 *
 * - `none`: the line plays on.
 * - `after-sentence`: the current sentence ends, and the rest of the line is dropped.
 * - `now`: the line stops at once, with a short fade.
 */
export type InterruptionDecision = 'none' | 'after-sentence' | 'now'

/**
 * Decides whether a new event interrupts the line that plays now. An interruption needs a very large event, clearly
 * larger than the event that started the line, and it waits for the cooldown after the last interruption. The owner's
 * speech is not an event here: it always stops the character.
 *
 * @example
 * decideInterruption({ salience: 0.9, lineSalience: 0.3, now: 60_000 })
 * // => 'after-sentence'
 */
export function decideInterruption(input: { salience: number, lineSalience: number, lastInterruptAt?: number, now: number }): InterruptionDecision {
  const { minInterruptSalience, interruptMargin, hardInterruptSalience, interruptCooldownMs } = COMMENTARY_LIMITS
  if (input.lastInterruptAt !== undefined && input.now - input.lastInterruptAt < interruptCooldownMs)
    return 'none'
  if (input.salience < minInterruptSalience || input.salience < input.lineSalience + interruptMargin)
    return 'none'
  return input.salience >= hardInterruptSalience ? 'now' : 'after-sentence'
}
