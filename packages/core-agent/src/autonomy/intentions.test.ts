import type { Intention } from './intentions'

import { describe, expect, it } from 'vitest'

import { createIntention, INTENTION_LIMITS, openIntentions } from './intentions'

const HOUR_MS = 60 * 60_000

function intention(id: string, createdAt: number, expiresAt: number): Intention {
  return { id, text: id, createdAt, expiresAt }
}

describe('createIntention', () => {
  it('creates an intention with an end time from the hours', () => {
    const result = createIntention({ id: 'trip', request: { text: '  Ask about   the trip ', hours: 24 }, now: 1_000, open: [] })

    expect(result).toEqual({ ok: true, intention: { id: 'trip', text: 'Ask about the trip', createdAt: 1_000, expiresAt: 1_000 + 24 * HOUR_MS } })
  })

  it('refuses empty text, long text, and hours outside the limits', () => {
    const create = (text: string, hours: number) => createIntention({ id: 'a', request: { text, hours }, now: 0, open: [] }).ok

    expect(create('   ', 24)).toBe(false)
    expect(create('x'.repeat(INTENTION_LIMITS.maxTextLength + 1), 24)).toBe(false)
    expect(create('ok', INTENTION_LIMITS.minHours - 0.5)).toBe(false)
    expect(create('ok', INTENTION_LIMITS.maxHours + 1)).toBe(false)
    expect(create('ok', Number.NaN)).toBe(false)
    expect(create('x'.repeat(INTENTION_LIMITS.maxTextLength), INTENTION_LIMITS.maxHours)).toBe(true)
  })

  it('refuses a new intention when the open ones are full, and counts only open ones', () => {
    const full = Array.from({ length: INTENTION_LIMITS.maxOpen }, (_, index) => intention(`open-${index}`, 0, 10 * HOUR_MS))

    const refused = createIntention({ id: 'new', request: { text: 'more', hours: 1 }, now: HOUR_MS, open: full })
    expect(refused).toMatchObject({ ok: false })

    const afterEnd = createIntention({ id: 'new', request: { text: 'more', hours: 1 }, now: 10 * HOUR_MS, open: full })
    expect(afterEnd).toMatchObject({ ok: true })
  })
})

describe('openIntentions', () => {
  it('keeps the intentions that did not end, oldest first', () => {
    const intentions = [intention('late', 2, 100), intention('ended', 0, 50), intention('early', 1, 100)]

    expect(openIntentions(intentions, 50).map(entry => entry.id)).toEqual(['early', 'late'])
  })
})
