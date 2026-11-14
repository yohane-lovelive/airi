import type { MemoryEntry } from '../types/memory'

import { describe, expect, it } from 'vitest'

import { chooseMergePairs, MEMORY_MERGE_LIMITS, memoryMergeRequest, memoryPairKey, mergeActionOf } from './memory-merge'

function entry(id: string, updatedAt: number, body = `fact ${id}`): MemoryEntry {
  return { id, description: `about ${id}`, body, persona: 'card', updatedAt }
}

const high = MEMORY_MERGE_LIMITS.minSimilarity + 0.1

describe('chooseMergePairs', () => {
  it('sends the most similar pairs, and skips pairs below the threshold or judged before', () => {
    const { send, waiting } = chooseMergePairs([
      { left: 'a', right: 'b', similarity: high },
      { left: 'c', right: 'd', similarity: high + 0.1 },
      { left: 'e', right: 'f', similarity: MEMORY_MERGE_LIMITS.minSimilarity - 0.1 },
      { left: 'g', right: 'h', similarity: high },
    ], new Set([memoryPairKey('h', 'g')]))

    expect(send).toEqual([['c', 'd'], ['a', 'b']])
    expect(waiting.size).toBe(0)
  })

  // ROOT CAUSE:
  // Groups chained unrelated entries through shared words, for example "オーナーは", and one answer for a whole group
  // then kept real copies apart. A pair is the unit now, so one answer decides one pair.
  it('puts no entry in two pairs, and holds back the pairs that it does not send', () => {
    const { send, waiting } = chooseMergePairs([
      { left: 'a', right: 'b', similarity: high + 0.2 },
      { left: 'b', right: 'c', similarity: high + 0.1 },
      { left: 'a', right: 'b', similarity: high },
    ], new Set())

    expect(send).toEqual([['a', 'b']])
    expect([...waiting]).toEqual(['b', 'c'])
  })

  it('sends at most the limit of pairs', () => {
    const pairs = Array.from({ length: MEMORY_MERGE_LIMITS.maxPairs + 2 }, (_, index) => ({ left: `l${index}`, right: `r${index}`, similarity: high }))

    const { send, waiting } = chooseMergePairs(pairs, new Set())

    expect(send).toHaveLength(MEMORY_MERGE_LIMITS.maxPairs)
    expect(waiting.size).toBe(4)
  })
})

describe('mergeActionOf', () => {
  const sent = [[entry('a', 1), entry('b', 3)]]

  it('keeps the newer entry and forgets the older one', () => {
    expect(mergeActionOf({ ids: ['a', 'b'], merged: { description: ' likes ramen ', body: ' The owner likes ramen. ' } }, sent))
      .toEqual({ kind: 'merge', keep: 'b', forget: 'a', description: 'likes ramen', body: 'The owner likes ramen.' })
  })

  it('records a pair that the model kept apart', () => {
    expect(mergeActionOf({ ids: ['b', 'a'], merged: null }, sent)).toEqual({ kind: 'distinct', pair: memoryPairKey('a', 'b') })
  })

  it('refuses an id that the merge did not send, so the model cannot forget another entry', () => {
    expect(mergeActionOf({ ids: ['a', 'z'], merged: { description: 'x', body: 'y' } }, sent)).toBeUndefined()
    expect(mergeActionOf({ ids: ['a'], merged: { description: 'x', body: 'y' } }, sent)).toBeUndefined()
    expect(mergeActionOf({ ids: ['a', 'b'], merged: { description: 'x', body: '   ' } }, sent)).toBeUndefined()
  })
})

describe('memoryMergeRequest', () => {
  it('lists each pair with the ids, dates, and texts of its entries', () => {
    const request = memoryMergeRequest([[entry('a', Date.UTC(2026, 10, 1)), entry('b', Date.UTC(2026, 10, 3))]])
    const text = JSON.stringify(request.turns.at(-1))

    expect(text).toContain('Pair 1:')
    expect(text).toContain('- a (2026-11-01): about a / fact a')
    expect(text).toContain('- b (2026-11-03)')
  })
})
