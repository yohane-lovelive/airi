import { createPinia, disposePinia } from 'pinia'
import { prefixStorage } from 'unstorage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { storage } from '../database/storage'
import { useIntentionsStore } from './intentions'

const records = prefixStorage(storage, 'intentions')
const stores: ReturnType<typeof createPinia>[] = []

/** Each store stands for one window. */
function createStore() {
  const pinia = createPinia()
  stores.push(pinia)
  return useIntentionsStore(pinia)
}

describe('intentions store', () => {
  beforeEach(async () => {
    await records.clear()
  })

  afterEach(async () => {
    vi.useRealTimers()
    for (const pinia of stores.splice(0))
      disposePinia(pinia)
    await records.clear()
  })

  it('keeps a new intention in IndexedDB, so another window reads it', async () => {
    const first = createStore()
    const result = await first.add({ text: 'Ask about the trip', hours: 24 })

    const second = createStore()
    await vi.waitFor(() => expect(second.openAt(Date.now()).map(intention => intention.text)).toEqual(['Ask about the trip']))
    expect(result.ok).toBe(true)
  })

  it('applies the intentions of a sync round at once, and tells the other windows', async () => {
    const leader = createStore()
    const other = createStore()
    const added = await leader.add({ text: 'Ask about the trip', hours: 24 })
    if (!added.ok)
      throw new Error(added.reason)
    const remote = { id: 'remote', text: 'Ask about the cat', createdAt: Date.now(), expiresAt: Date.now() + 60_000 }

    const applied = leader.applySyncIntentions([remote], [added.intention.id])
    expect(leader.intentions.map(intention => intention.text)).toEqual(['Ask about the cat'])

    await applied
    await vi.waitFor(() => expect(other.intentions.map(intention => intention.id)).toEqual(['remote']))
  })

  it('finishes an open intention once', async () => {
    const intentions = createStore()
    const result = await intentions.add({ text: 'Recall the cat', hours: 1 })
    if (!result.ok)
      throw new Error(result.reason)

    expect(await intentions.finish(result.intention.id)).toBe(true)
    expect(await intentions.finish(result.intention.id)).toBe(false)
    expect(intentions.openAt(Date.now())).toEqual([])
  })

  // Ended intentions must not fill the store, and must not count toward the limit.
  it('removes ended intentions when it adds a new one', async () => {
    const intentions = createStore()
    for (let index = 0; index < 5; index++)
      await intentions.add({ text: `Idea ${index}`, hours: 1 })
    expect((await intentions.add({ text: 'Full', hours: 1 })).ok).toBe(false)

    vi.useFakeTimers({ now: Date.now() + 2 * 60 * 60_000, toFake: ['Date'] })
    const result = await intentions.add({ text: 'Later', hours: 1 })

    expect(result.ok).toBe(true)
    expect(intentions.intentions.map(intention => intention.text)).toEqual(['Later'])
  })

  it('clears every intention on a reset', async () => {
    const intentions = createStore()
    await intentions.add({ text: 'Ask about the trip', hours: 24 })

    await intentions.resetState()

    expect(intentions.intentions).toEqual([])
    expect(await records.getKeys()).toHaveLength(0)
  })
})
