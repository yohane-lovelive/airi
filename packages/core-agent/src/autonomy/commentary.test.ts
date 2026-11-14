import { describe, expect, it } from 'vitest'

import { COMMENTARY_LIMITS, commentaryIntervalFactor, decideInterruption } from './commentary'

describe('commentaryIntervalFactor', () => {
  it('stretches the interval on a calm screen and shrinks it on an active one', () => {
    expect(commentaryIntervalFactor(0)).toBe(COMMENTARY_LIMITS.calmIntervalFactor)
    expect(commentaryIntervalFactor(1)).toBe(COMMENTARY_LIMITS.activeIntervalFactor)
    expect(commentaryIntervalFactor(0.5)).toBeCloseTo(1.25)
    expect(commentaryIntervalFactor(3)).toBe(COMMENTARY_LIMITS.activeIntervalFactor)
  })
})

describe('decideInterruption', () => {
  it('lets the sentence end for a very large event, and stops at once for the largest', () => {
    expect(decideInterruption({ salience: 0.85, lineSalience: 0.2, now: 0 })).toBe('after-sentence')
    expect(decideInterruption({ salience: 0.97, lineSalience: 0.2, now: 0 })).toBe('now')
  })

  it('needs a clear margin over the event that started the line', () => {
    expect(decideInterruption({ salience: 0.9, lineSalience: 0.7, now: 0 })).toBe('none')
    expect(decideInterruption({ salience: 0.7, lineSalience: 0, now: 0 })).toBe('none')
  })

  it('waits for the cooldown after the last interruption', () => {
    expect(decideInterruption({ salience: 0.99, lineSalience: 0, lastInterruptAt: 0, now: COMMENTARY_LIMITS.interruptCooldownMs - 1 })).toBe('none')
    expect(decideInterruption({ salience: 0.99, lineSalience: 0, lastInterruptAt: 0, now: COMMENTARY_LIMITS.interruptCooldownMs })).toBe('now')
  })
})
