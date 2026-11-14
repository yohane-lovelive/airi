import { describe, expect, it } from 'vitest'

import { isOwnerTyping, nextOwnerTypingUntil, OWNER_TYPING_MIN_HOLD_MS, OWNER_TYPING_REFRESH_MS } from './typing'

describe('nextOwnerTypingUntil', () => {
  it('starts a typing window after the first input', () => {
    const until = nextOwnerTypingUntil(0, 1_000)

    expect(until).toBe(1_000 + OWNER_TYPING_MIN_HOLD_MS + OWNER_TYPING_REFRESH_MS)
  })

  it('writes nothing while the stored end is recent', () => {
    const until = nextOwnerTypingUntil(0, 1_000)!

    expect(nextOwnerTypingUntil(until, 1_000 + OWNER_TYPING_REFRESH_MS - 1)).toBeUndefined()
  })

  it('extends the window once the refresh time passed', () => {
    const until = nextOwnerTypingUntil(0, 1_000)!
    const now = 1_000 + OWNER_TYPING_REFRESH_MS

    expect(nextOwnerTypingUntil(until, now)).toBe(now + OWNER_TYPING_MIN_HOLD_MS + OWNER_TYPING_REFRESH_MS)
  })

  it('keeps the owner typing for the minimum hold after the last input', () => {
    // The last input comes just before a refresh, so it writes nothing. The hold must still cover it.
    const until = nextOwnerTypingUntil(0, 0)!
    const lastInput = OWNER_TYPING_REFRESH_MS - 1

    expect(nextOwnerTypingUntil(until, lastInput)).toBeUndefined()
    expect(isOwnerTyping(until, lastInput + OWNER_TYPING_MIN_HOLD_MS)).toBe(true)
  })
})

describe('isOwnerTyping', () => {
  it('ends at the stored end', () => {
    expect(isOwnerTyping(10_000, 9_999)).toBe(true)
    expect(isOwnerTyping(10_000, 10_000)).toBe(false)
    expect(isOwnerTyping(0, 1)).toBe(false)
  })
})
