import { createPinia, disposePinia } from 'pinia'
import { prefixStorage } from 'unstorage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { storage } from '../database/storage'
import { MEMORY_WORK_LIMITS } from '../libs/memory-work'
import { useOwnerProfileStore } from './owner-profile'

const records = prefixStorage(storage, 'owner-profile')
const stores: ReturnType<typeof createPinia>[] = []

/** Each store stands for one window. */
function createStore() {
  const pinia = createPinia()
  stores.push(pinia)
  return useOwnerProfileStore(pinia)
}

describe('owner profile store', () => {
  beforeEach(async () => {
    await records.clear()
  })

  afterEach(async () => {
    for (const pinia of stores.splice(0))
      disposePinia(pinia)
    await records.clear()
  })

  it('keeps the profile cut to its budget, so another window reads it, and clears it', async () => {
    const first = createStore()
    const second = createStore()
    await second.ready()

    await first.set(`  ${'猫'.repeat(MEMORY_WORK_LIMITS.profileMaxChars + 50)}  `)

    expect(first.profile?.text).toHaveLength(MEMORY_WORK_LIMITS.profileMaxChars)
    await vi.waitFor(() => expect(second.profile?.text).toBe(first.profile?.text))

    await first.clear()
    expect(first.profile).toBeUndefined()
    await vi.waitFor(() => expect(second.profile).toBeUndefined())
  })

  it('applies the profile of a sync round at once, and counts no local change', async () => {
    const profile = createStore()
    await profile.ready()
    const changesBefore = profile.changeCount

    const applied = profile.applySyncProfile({ text: 'ラーメンが好き', updatedAt: 5 })
    expect(profile.profile).toEqual({ text: 'ラーメンが好き', updatedAt: 5 })

    await applied
    expect(await records.getItemRaw('owner-profile')).toEqual({ text: 'ラーメンが好き', updatedAt: 5 })
    expect(profile.changeCount).toBe(changesBefore)
  })
})
