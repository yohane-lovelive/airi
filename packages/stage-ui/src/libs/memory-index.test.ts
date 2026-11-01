import type { MemoryEntry } from '../types/memory'

import { describe, expect, it } from 'vitest'

import { MEMORY_INDEX_LIMIT, memoryIndexEntries, searchMemories } from './memory-index'

function entry(id: string, updatedAt: number, description = id, persona?: string): MemoryEntry {
  return { id, description, body: `${description} body`, updatedAt, ...(persona ? { persona } : {}) }
}

describe('memory index', () => {
  it('lists own entries before general ones, each newest first', () => {
    const entries = [entry('g-old', 1), entry('own-old', 2, 'own-old', 'airi'), entry('g-new', 3), entry('other', 4, 'other', 'luna'), entry('own-new', 5, 'own-new', 'airi')]

    const index = memoryIndexEntries(entries, 'airi')

    expect(index.own.map(item => item.id)).toEqual(['own-new', 'own-old'])
    expect(index.general.map(item => item.id)).toEqual(['g-new', 'g-old'])
    expect(index.hidden).toBe(0)
  })

  // A large memory must not fill every request. The model searches the older entries.
  it('stops at the limit and counts the entries that it leaves out', () => {
    const entries = Array.from({ length: MEMORY_INDEX_LIMIT + 7 }, (_, index) => entry(`e${index}`, index))

    const index = memoryIndexEntries(entries, 'airi')

    expect(index.general).toHaveLength(MEMORY_INDEX_LIMIT)
    expect(index.general[0]?.id).toBe(`e${MEMORY_INDEX_LIMIT + 6}`)
    expect(index.hidden).toBe(7)
  })

  it('finds Japanese and English entries by shared character pairs, best first', () => {
    const entries = [
      entry('birthday', 1, 'オーナーの誕生日は 5 月 3 日'),
      entry('cat', 2, 'The owner has a cat named Tama'),
      entry('trip', 3, '5 月に京都へ旅行する'),
    ]

    expect(searchMemories(entries, '誕生日').map(item => item.id)).toEqual(['birthday'])
    expect(searchMemories(entries, 'CAT name').map(item => item.id)).toEqual(['cat'])
    expect(searchMemories(entries, '京都の旅行').map(item => item.id)[0]).toBe('trip')
    expect(searchMemories(entries, 'zz')).toEqual([])
  })
})
