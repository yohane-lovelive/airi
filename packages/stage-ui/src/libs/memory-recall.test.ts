import type { Conversation } from '@proj-airi/core-agent'

import type { MemoryEntry } from '../types/memory'

import { describe, expect, it, vi } from 'vitest'

import { composeRecalledMemories, newestUserText, RECALLED_MEMORIES_SOURCE, recallMemories, withRecalledMemories } from './memory-recall'

function entry(id: string, body: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id, description: '', body, persona: 'airi', updatedAt: 10, ...overrides }
}

const ENTRIES = [
  entry('ramen', '好物はラーメン'),
  entry('trip', '来週は大阪へ旅行'),
  entry('cat', '猫を飼っている', { persona: undefined }),
  entry('other', 'ラーメンが嫌い', { persona: 'someone' }),
]

describe('recallMemories', () => {
  it('takes the server results in their order, for the card and the general entries', async () => {
    const searchByMeaning = vi.fn(async () => [{ id: 'cat', score: 0.8 }, { id: 'ramen', score: 0.7 }, { id: 'gone', score: 0.6 }, { id: 'other', score: 0.5 }])

    const result = await recallMemories({ query: 'ペットは？', personaId: 'airi', limit: 5, entries: ENTRIES, searchByMeaning })

    expect(result).toEqual({ mode: 'meaning', entries: [ENTRIES[2], ENTRIES[0]] })
  })

  it('adds entries that changed after the last sync, by shared characters', async () => {
    const fresh = entry('fresh', 'ラーメン屋の新店', { updatedAt: 50 })

    const result = await recallMemories({
      query: 'ラーメン',
      personaId: 'airi',
      limit: 5,
      entries: [...ENTRIES, fresh],
      searchByMeaning: async () => [{ id: 'ramen', score: 0.9 }],
      syncedAt: 20,
    })

    expect(result.entries.map(item => item.id)).toEqual(['ramen', 'fresh'])
  })

  it('uses shared characters on a server error, after the timeout, and without a server', async () => {
    const failed = await recallMemories({ query: 'ラーメン', personaId: 'airi', limit: 5, entries: ENTRIES, searchByMeaning: () => Promise.reject(new Error('503')) })
    const slow = await recallMemories({
      query: 'ラーメン',
      personaId: 'airi',
      limit: 5,
      entries: ENTRIES,
      timeoutMs: 10,
      searchByMeaning: signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    })
    const local = await recallMemories({ query: 'ラーメン', personaId: 'airi', limit: 5, entries: ENTRIES })

    for (const result of [failed, slow, local])
      expect(result).toEqual({ mode: 'characters', entries: [ENTRIES[0]] })
  })
})

describe('composeRecalledMemories', () => {
  it('lists each entry with its id, owner, index line, and a short body, and says how it was found', () => {
    const text = composeRecalledMemories({
      mode: 'meaning',
      entries: [entry('ramen', 'a'.repeat(500), { description: 'Food' }), entry('cat', '猫を飼っている', { persona: undefined })],
    })

    expect(text).toContain('found by meaning')
    expect(text).toContain(`- ramen (yours): Food\n  ${'a'.repeat(399)}…`)
    expect(text).toContain('- cat (general): 猫を飼っている')
    expect(composeRecalledMemories({ mode: 'characters', entries: [] })).toBe('')
  })
})

describe('withRecalledMemories', () => {
  function conversation(): Conversation {
    return {
      turns: [
        { id: 'system', type: 'system', authority: 'system', content: [{ type: 'text', text: 'persona' }] },
        { id: 'old', type: 'user', content: [{ type: 'text', text: '昨日の話' }] },
        { id: 'new', type: 'user', content: [{ type: 'text', text: '好きな食べ物は？' }, { type: 'runtime-context', entries: [{ source: 'system:user-account', text: 'name' }] }] },
      ],
    }
  }

  it('reads the text of the newest user turn', () => {
    expect(newestUserText(conversation())).toBe('好きな食べ物は？')
  })

  it('adds the memories to the context of the newest user turn in a copy, and leaves the input as it was', () => {
    const input = conversation()
    const before = structuredClone(input)

    const output = withRecalledMemories(input, '- ramen (yours): 好物はラーメン')

    expect(input).toEqual(before)
    expect(output.turns.at(-1)).toEqual({
      id: 'new',
      type: 'user',
      content: [
        { type: 'text', text: '好きな食べ物は？' },
        { type: 'runtime-context', entries: [{ source: 'system:user-account', text: 'name' }, { source: RECALLED_MEMORIES_SOURCE, text: '- ramen (yours): 好物はラーメン' }] },
      ],
    })
    expect(output.turns[1]).toBe(input.turns[1])
    expect(withRecalledMemories(input, '')).toBe(input)
  })
})
