import type { MemoryEntry } from '../../types/memory'

import { describe, expect, it } from 'vitest'

import { applyMemoryChanges, createdAtOfId, memoryFromFields, memoryToFields } from '.'

// A UUIDv7 made at 2026-11-02T00:00:00.000Z, which is 0x1a1998e4400 milliseconds after 1970.
const V7_ID = '01a1998e-4400-7000-8000-000000000001'
const V7_TIME = 0x1A1998E4400
const NOW = V7_TIME + 60_000

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id: 'm1', description: 'Food', body: 'Ramen.', persona: 'airi', updatedAt: 1, ...overrides }
}

describe('memory fields', () => {
  it('splits an entry into its synced fields, without the time and without a card for a general entry', () => {
    expect(memoryToFields(entry())).toEqual({ description: 'Food', body: 'Ramen.', persona: 'airi' })
    expect(memoryToFields(entry({ persona: undefined }))).toEqual({ description: 'Food', body: 'Ramen.' })
  })

  it('joins valid fields and refuses fields that break the limits or are unknown', () => {
    expect(memoryFromFields('m1', { body: 'Ramen.' }, 5)).toEqual({ id: 'm1', description: '', body: 'Ramen.', updatedAt: 5 })
    expect(memoryFromFields('m1', { description: 'Food' }, 5)).toBeUndefined()
    expect(memoryFromFields('m1', { body: 'a'.repeat(2_001) }, 5)).toBeUndefined()
    expect(memoryFromFields('m1', { body: 'x', persona: '' }, 5)).toBeUndefined()
    expect(memoryFromFields('m1', { body: 'x', extra: 1 }, 5)).toBeUndefined()
    expect(memoryFromFields('m1', { body: 1 }, 5)).toBeUndefined()
  })

  it('reads the creation time of a UUIDv7, and falls back for other ids and future times', () => {
    expect(createdAtOfId(V7_ID, NOW)).toBe(V7_TIME)
    expect(createdAtOfId('legacy-name', NOW)).toBe(NOW)
    expect(createdAtOfId(V7_ID, V7_TIME - 1)).toBe(V7_TIME - 1)
  })
})

describe('applyMemoryChanges', () => {
  it('replaces known entries, adds new ones at the time of their id, and drops removed ones', () => {
    const current = [entry({ id: 'm1', updatedAt: 1 }), entry({ id: 'm2', body: 'Cat.', updatedAt: 2 })]

    const applied = applyMemoryChanges(current, {
      upserts: { m1: { description: 'Food', body: 'Tonkotsu ramen.', persona: 'airi' }, [V7_ID]: { body: 'Trip to Osaka.' } },
      removals: ['m2', 'missing'],
      conflictCopies: [],
    }, NOW, () => 'new')

    expect(applied.entries.map(item => [item.id, item.body, item.updatedAt])).toEqual([
      [V7_ID, 'Trip to Osaka.', V7_TIME],
      ['m1', 'Tonkotsu ramen.', NOW],
    ])
    expect(applied.removed).toEqual(['m2'])
    expect(applied.rejected).toEqual([])
  })

  it('keeps a local entry whose remote fields are invalid, and reports it', () => {
    const applied = applyMemoryChanges([entry()], { upserts: { m1: { body: '' } }, removals: [], conflictCopies: [] }, NOW, () => 'new')

    expect(applied.rejected).toEqual(['m1'])
    expect(applied.entries).toEqual([entry()])
    expect(applied.saved).toEqual([])
  })

  it('keeps the local side of a lost conflict as a new entry', () => {
    const applied = applyMemoryChanges([entry()], {
      upserts: { m1: { description: 'Food', body: 'Sushi.', persona: 'airi' } },
      removals: [],
      conflictCopies: [{ documentId: 'm1', fields: { description: 'Food', body: 'Ramen.', persona: 'airi' } }],
    }, NOW, () => 'copy')

    expect(applied.entries.map(item => [item.id, item.body])).toEqual([['m1', 'Sushi.'], ['copy', 'Ramen.']])
    expect(applied.saved.map(item => item.id).sort()).toEqual(['copy', 'm1'])
  })
})
