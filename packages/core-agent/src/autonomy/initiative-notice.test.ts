import type { InitiativeNoticeContext } from './initiative-notice'

import { describe, expect, it } from 'vitest'

import { initiativeNoticeText } from './initiative-notice'

const NOW = Date.UTC(2026, 10, 1, 12, 0)

function context(overrides: Partial<InitiativeNoticeContext> = {}): InitiativeNoticeContext {
  return { mode: 'idle', trigger: 'boredom', now: NOW, localMinutes: 20 * 60, recentLines: [], ...overrides }
}

describe('initiativeNoticeText', () => {
  it('tells the reason, the time of day, and the time since the last messages', () => {
    const text = initiativeNoticeText(context({ lastOwnerAt: NOW - 42 * 60_000, lastSpokeAt: NOW - 3 * 60 * 60_000 }))

    expect(text).toContain('it has been quiet for a while')
    expect(text).toContain('Time of day: evening.')
    expect(text).toContain('Since the owner\'s last message: 42 minutes.')
    expect(text).toContain('Since your last line: about 3 hours.')
  })

  it('says when the conversation has no earlier messages', () => {
    expect(initiativeNoticeText(context())).toContain('Since the owner\'s last message: none in this conversation.')
  })

  it('lists the open intentions with their ids, and names them as the reason', () => {
    const text = initiativeNoticeText(context({
      trigger: 'intention',
      intentions: [{ id: 'trip', text: 'Ask about the trip', createdAt: NOW - 2 * 60 * 60_000, expiresAt: NOW + 60_000 }],
    }))

    expect(text).toContain('Why now: you wanted to do something later.')
    expect(text).toContain('- trip: "Ask about the trip" (noted about 2 hours ago)')
    expect(initiativeNoticeText(context())).not.toContain('wanted to do')
  })

  it('gives the speech type as a light idea, and gives none in a hintless turn', () => {
    expect(initiativeNoticeText(context({ speechType: 'ask' }))).toContain('Idea, only if it fits: ask the owner a question.')
    expect(initiativeNoticeText(context())).not.toContain('Idea')
  })

  it('lists only the last three lines, cut short, so the block keeps its size', () => {
    const long = 'a'.repeat(500)
    const text = initiativeNoticeText(context({ recentLines: ['first', 'second', 'third', long] }))

    expect(text).not.toContain('"first"')
    expect(text).toContain('"second"')
    expect(text).toContain(`"${'a'.repeat(119)}…"`)
    // About 300 tokens at most. English text has about 4 characters for each token.
    expect(initiativeNoticeText(context({ mode: 'commentary', speechType: 'recall', recentLines: [long, long, long] })).length).toBeLessThan(1200)
  })

  it('asks for one short sentence in commentary', () => {
    expect(initiativeNoticeText(context({ mode: 'commentary', trigger: 'event' }))).toContain('Mode: commentary. Keep it to one short sentence.')
  })
})
