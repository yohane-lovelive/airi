import localforage from 'localforage'

import { createPinia, disposePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useUsageStore } from './usage'

const records = localforage.createInstance({ name: 'airi-usage', storeName: 'usage' })
const stores: ReturnType<typeof createPinia>[] = []

/** Each store stands for one window. */
function createStore() {
  const pinia = createPinia()
  stores.push(pinia)
  return useUsageStore(pinia)
}

const call = { purpose: 'owner-reply' as const, model: 'm', calls: 1, tokens: { input: 100, output: 20, total: 120 }, images: 0 }

describe('usage store', () => {
  beforeEach(async () => {
    await records.clear()
  })

  afterEach(async () => {
    for (const pinia of stores.splice(0))
      disposePinia(pinia)
    await records.clear()
  })

  // Two windows can finish a call at the same time. The lock keeps both calls.
  it('keeps the calls of two windows in one record, and both windows read it', async () => {
    const first = createStore()
    const second = createStore()

    await Promise.all([first.record({ ...call, at: Date.now() }), second.record({ ...call, at: Date.now() })])

    await expect.poll(() => first.records[0]?.totalTokens).toBe(240)
    await expect.poll(() => second.records[0]?.calls).toBe(2)
  })

  // Each window removes old records once a day. The call of tomorrow is the first of its day also after other tests.
  it('removes records older than 30 days on the first call of a day', async () => {
    await records.setItem('2026-01-01|owner-reply|m', { day: '2026-01-01', purpose: 'owner-reply', model: 'm', calls: 1, unreportedCalls: 0, inputTokens: 1, outputTokens: 0, totalTokens: 1, images: 0 })
    const usage = createStore()

    await usage.record({ ...call, at: Date.now() + 24 * 60 * 60_000 })

    expect(usage.records.map(record => record.day)).not.toContain('2026-01-01')
  })

  it('clears every record on a reset', async () => {
    const usage = createStore()
    await usage.record({ ...call, at: Date.now() })

    await usage.resetState()

    expect(usage.records).toEqual([])
    expect(await records.length()).toBe(0)
  })
})
