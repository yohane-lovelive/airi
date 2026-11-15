import type { MemoryEntry } from '../types/memory'

import { describe, expect, it } from 'vitest'

import { GAME_ACCOUNT_LIMIT, gameAccounts, MEMORY_INDEX_LIMIT, memoryIndexEntries, searchMemories } from './memory-index'

function entry(id: string, updatedAt: number, description = id, persona?: string): MemoryEntry {
  return { id, description, body: `${description} body`, updatedAt, ...(persona ? { persona } : {}) }
}

describe('game accounts', () => {
  function account(id: string, updatedAt: number, description: string, body: string, persona?: string): MemoryEntry {
    return { id, description, body, updatedAt, ...(persona ? { persona } : {}) }
  }

  it('lists the player names of the card and the general ones, newest first', () => {
    const entries = [
      account('lol', 1, 'Game account: League of Legends', 'moonrabbit'),
      account('apex', 3, 'game account:  Apex Legends', ' moon_rabbit\n(told on a stream) ', 'airi'),
      account('other-card', 4, 'Game account: Valorant', 'someone', 'luna'),
      account('likes', 5, 'The owner likes ramen.', 'Ramen.'),
    ]

    expect(gameAccounts(entries, 'airi')).toEqual(['Apex Legends: moon_rabbit (told on a stream)', 'League of Legends: moonrabbit'])
  })

  // The index of a request lists only the newest memories. An old account must still reach a turn about the screen.
  it('finds an account that is older than every entry of the index', () => {
    const entries = [
      account('lol', 0, 'Game account: League of Legends', 'moonrabbit'),
      ...Array.from({ length: MEMORY_INDEX_LIMIT + 5 }, (_, index) => entry(`e${index}`, index + 1)),
    ]

    expect(memoryIndexEntries(entries, 'airi').general.some(item => item.id === 'lol')).toBe(false)
    expect(gameAccounts(entries, 'airi')).toEqual(['League of Legends: moonrabbit'])
  })

  it('leaves out an entry without a game or a name, and stops at its limit', () => {
    const many = Array.from({ length: GAME_ACCOUNT_LIMIT + 3 }, (_, index) => account(`g${index}`, index, `Game account: Game ${index}`, `name${index}`))

    expect(gameAccounts([account('no-game', 1, 'Game account:', 'moonrabbit'), account('no-name', 2, 'Game account: Chess', '   ')], 'airi')).toEqual([])
    expect(gameAccounts(many, 'airi')).toHaveLength(GAME_ACCOUNT_LIMIT)
    expect(gameAccounts(many, 'airi')[0]).toBe(`Game ${GAME_ACCOUNT_LIMIT + 2}: name${GAME_ACCOUNT_LIMIT + 2}`)
  })
})

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
