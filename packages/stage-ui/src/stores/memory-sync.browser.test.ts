import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import type { SynchronizeOptions } from '../libs/document-sync'

import localforage from 'localforage'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { useAuthStore } from './auth'
import { useFeatureFlagsStore } from './feature-flags'
import { useMemoryStore } from './memory'
import { useMemorySyncStore } from './memory-sync'

const { synchronize } = vi.hoisted(() => ({
  synchronize: vi.fn(async (_options: SynchronizeOptions) => ({ state: { documents: {} }, refused: [] as string[] })),
}))

// The server exchange is the boundary. The fake reads and writes the local side as the real run does.
vi.mock('../libs/document-sync', async importOriginal => ({
  ...await importOriginal<typeof import('../libs/document-sync')>(),
  synchronize,
}))

const records = localforage.createInstance({ name: 'airi-memory', storeName: 'entries' })

function leaderRuntime(): Pick<SyncedPiniaRuntime, 'isLeader' | 'onLeadershipChange'> {
  return {
    isLeader: () => true,
    onLeadershipChange(listener) {
      listener(true)
      return () => {}
    },
  }
}

/** A run reads its sync state from IndexedDB before it calls `synchronize`, so wait real time. */
async function settle() {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 200))
}

describe('memory sync store', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(async () => {
    await records.clear()
    synchronize.mockClear()
    pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().user = { id: 'user-1', name: 'user-1', email: 'user-1@example.test', emailVerified: true, createdAt: new Date(), updatedAt: new Date() }
    await settle()
  })

  afterEach(async () => {
    disposePinia(pinia)
    await records.clear()
  })

  it('does nothing while the experiment is off', async () => {
    useMemorySyncStore().initialize(leaderRuntime())
    await settle()

    expect(synchronize).not.toHaveBeenCalled()
    expect(useMemorySyncStore().active).toBe(false)
  })

  it('sends the local entries as fields, applies the remote changes, and records the time of the run', async () => {
    const memory = useMemoryStore()
    const local = (await memory.write({ description: 'Food', body: 'Ramen.' }, 'airi'))!
    synchronize.mockImplementationOnce(async (options) => {
      expect(options.readLocal()).toEqual({ [local.id]: { description: 'Food', body: 'Ramen.', persona: 'airi' } })
      await options.applyLocal({ upserts: { remote: { description: 'Pet', body: 'A cat.' } }, removals: [], conflictCopies: [] })
      return { state: { documents: {} }, refused: [] }
    })
    useFeatureFlagsStore().setPreference('memory-sync', true)

    const sync = useMemorySyncStore()
    sync.initialize(leaderRuntime())
    await vi.waitFor(() => expect(sync.lastSyncedAt).toBeTypeOf('number'))

    expect(memory.read('remote', 'airi')?.body).toBe('A cat.')
  })

  it('runs again after a new fact, once for a burst of writes', async () => {
    useFeatureFlagsStore().setPreference('memory-sync', true)
    const memory = useMemoryStore()
    useMemorySyncStore().initialize(leaderRuntime())
    await settle()
    synchronize.mockClear()

    await memory.write({ description: 'Food', body: 'Ramen.' }, 'airi')
    await memory.write({ description: 'Pet', body: 'A cat.' }, 'airi')

    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1), { timeout: 4_000 })
    await settle()
    expect(synchronize).toHaveBeenCalledTimes(1)
  })
})
