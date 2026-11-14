import type { ChatHistoryItem } from '@proj-airi/core-agent'

import { describe, expect, it } from 'vitest'

import { INITIATIVE_SOURCE, initiativeConversationFacts, initiativeEventOf } from './conversation'

function owner(text: string, createdAt: number): ChatHistoryItem {
  return { role: 'user', content: text, createdAt, id: `user-${createdAt}` }
}

function notice(text: string, createdAt: number): ChatHistoryItem {
  return { role: 'user', content: text, createdAt, id: `notice-${createdAt}`, notice: { source: 'mission:reminder' } }
}

function reply(text: string, createdAt: number, source?: string): ChatHistoryItem {
  return {
    role: 'assistant',
    content: text,
    slices: [{ type: 'text', text }],
    tool_results: [],
    createdAt,
    id: `assistant-${createdAt}`,
    ...(source ? { proactive: { turnId: `turn-${createdAt}`, source } } : {}),
  }
}

describe('initiativeConversationFacts', () => {
  it('reads the last owner message and the last line, and skips notices', () => {
    const facts = initiativeConversationFacts([owner('hi', 1), reply('hello', 2), notice('reminder', 3), reply('medicine time', 4, 'mission:reminder')])

    expect(facts.lastOwnerAt).toBe(1)
    expect(facts.lastSpokeAt).toBe(4)
  })

  it('lists only the last three autonomous lines, oldest first', () => {
    const messages = [1, 2, 3, 4].map(index => reply(`line ${index}`, index, INITIATIVE_SOURCE))

    const facts = initiativeConversationFacts([...messages, reply('an answer', 5)])

    expect(facts.recentLines).toEqual(['line 2', 'line 3', 'line 4'])
  })

  it('has no times for an empty conversation', () => {
    expect(initiativeConversationFacts([])).toEqual({ recentLines: [] })
  })
})

describe('initiativeEventOf', () => {
  it('turns an owner message into owner-message and a notice into nothing', () => {
    expect(initiativeEventOf(owner('hi', 1))).toEqual({ type: 'owner-message' })
    expect(initiativeEventOf(notice('reminder', 1))).toBeUndefined()
  })

  it('counts a reply to the owner and a reminder, but not an autonomous line', () => {
    expect(initiativeEventOf(reply('hello', 1))).toEqual({ type: 'character-spoke' })
    expect(initiativeEventOf(reply('medicine time', 1, 'mission:reminder'))).toEqual({ type: 'character-spoke' })
    expect(initiativeEventOf(reply('hm', 1, INITIATIVE_SOURCE))).toBeUndefined()
  })
})
