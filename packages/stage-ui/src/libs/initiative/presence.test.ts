import { describe, expect, it } from 'vitest'

import { markAway, observePresence, OWNER_PRESENCE_LIMITS, shouldGreet } from './presence'

const NOW = Date.UTC(2026, 10, 1, 12, 0)
const MINUTE = 60_000

describe('owner presence', () => {
  it('makes the owner away after a long idle time, from the last input on', () => {
    const { presence, returnedAfterMs } = observePresence({}, 12 * MINUTE, NOW)

    expect(presence).toEqual({ awaySince: NOW - 12 * MINUTE })
    expect(returnedAfterMs).toBeUndefined()
    // Later readings keep the first start of the absence.
    expect(observePresence(presence, 40 * MINUTE, NOW + 28 * MINUTE).presence).toEqual({ awaySince: NOW - 12 * MINUTE })
  })

  it('tells how long the owner was away when input comes again', () => {
    const away = { awaySince: NOW - 45 * MINUTE }

    expect(observePresence(away, 5_000, NOW)).toEqual({ presence: {}, returnedAfterMs: 45 * MINUTE - 5_000 })
  })

  it('changes nothing while the owner works', () => {
    expect(observePresence({}, 30_000, NOW)).toEqual({ presence: {} })
  })

  // A screen lock surely means that the owner left, even before the idle time grows.
  it('marks the owner away at a screen lock, and keeps an earlier start', () => {
    expect(markAway({}, NOW)).toEqual({ awaySince: NOW })
    expect(markAway({ awaySince: NOW - MINUTE }, NOW)).toEqual({ awaySince: NOW - MINUTE })
  })

  it('greets in a new conversation or after a long quiet time only', () => {
    expect(shouldGreet(undefined, NOW)).toBe(true)
    expect(shouldGreet(NOW - OWNER_PRESENCE_LIMITS.greetingAfterMs, NOW)).toBe(true)
    expect(shouldGreet(NOW - 10 * MINUTE, NOW)).toBe(false)
  })
})
