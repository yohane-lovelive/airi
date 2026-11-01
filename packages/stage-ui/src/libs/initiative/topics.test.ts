import type { ChatHistoryItem } from '@proj-airi/core-agent'

import { describe, expect, it } from 'vitest'

import { INITIATIVE_SOURCE } from './conversation'
import { initiativeTopicLines, memoryTopicSeeds } from './topics'

function owner(text: string, createdAt: number, notice = false): ChatHistoryItem {
  return { role: 'user', content: text, createdAt, id: `user-${createdAt}`, ...(notice ? { notice: { source: 'mission:reminder' } } : {}) }
}

function reply(text: string, createdAt: number, options: { source?: string, topic?: string } = {}): ChatHistoryItem {
  return {
    role: 'assistant',
    content: text,
    slices: [{ type: 'text', text }],
    tool_results: [],
    createdAt,
    id: `assistant-${createdAt}`,
    ...(options.source ? { proactive: { turnId: `turn-${createdAt}`, source: options.source } } : {}),
    ...(options.topic ? { topic: options.topic } : {}),
  }
}

describe('initiativeTopicLines', () => {
  it('reads autonomous lines with their labels, and marks a line that the owner answered', () => {
    const lines = initiativeTopicLines([
      reply('ラーメン食べたい', 10, { source: INITIATIVE_SOURCE, topic: 'ラーメン' }),
      owner('いいね', 11),
      reply('どこにする？', 12),
      reply('週末どうする？', 13, { source: INITIATIVE_SOURCE, topic: '週末の予定' }),
      owner('reminder', 14, true),
    ], 0)

    expect(lines).toEqual([
      { text: 'ラーメン食べたい', label: 'ラーメン', at: 10, answered: true },
      { text: '週末どうする？', label: '週末の予定', at: 13, answered: false },
    ])
  })

  it('skips lines before `since`, replies to the owner, and other proactive replies', () => {
    const lines = initiativeTopicLines([
      reply('old', 5, { source: INITIATIVE_SOURCE }),
      owner('hi', 6),
      reply('medicine time', 20, { source: 'mission:reminder' }),
      reply('new', 21, { source: INITIATIVE_SOURCE }),
    ], 10)

    expect(lines).toEqual([{ text: 'new', at: 21, answered: false }])
  })
})

describe('memoryTopicSeeds', () => {
  it('gives the index lines of the card as seeds, own entries first', () => {
    const seeds = memoryTopicSeeds([
      { id: 'a', description: 'The owner likes ramen', body: '…', updatedAt: 1 },
      { id: 'b', description: 'I like cats', body: '…', persona: 'card', updatedAt: 2 },
      { id: 'c', description: 'Another card', body: '…', persona: 'other', updatedAt: 3 },
    ], 'card')

    expect(seeds).toEqual([{ text: 'I like cats', source: 'memory' }, { text: 'The owner likes ramen', source: 'memory' }])
  })
})
