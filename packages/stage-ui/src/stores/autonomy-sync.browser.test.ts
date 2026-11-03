import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import type { SynchronizeOptions } from '../libs/document-sync'

import localforage from 'localforage'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from './auth'
import { useAutonomySyncStore } from './autonomy-sync'
import { useFeatureFlagsStore } from './feature-flags'
import { useIntentionsStore } from './intentions'
import { useMissionsStore } from './missions'

const { synchronize } = vi.hoisted(() => ({
  synchronize: vi.fn(async (_options: SynchronizeOptions) => ({ state: { documents: {} }, refused: [] as string[] })),
}))

// The server exchange is the boundary. The fake reads and writes the local side as the real run does.
vi.mock('../libs/document-sync', async importOriginal => ({
  ...await importOriginal<typeof import('../libs/document-sync')>(),
  synchronize,
}))

const stores = [
  localforage.createInstance({ name: 'airi-missions', storeName: 'missions' }),
  localforage.createInstance({ name: 'airi-intentions', storeName: 'intentions' }),
]

function leaderRuntime(): Pick<SyncedPiniaRuntime, 'isLeader' | 'onLeadershipChange'> {
  return {
    isLeader: () => true,
    onLeadershipChange(listener) {
      listener(true)
      return () => {}
    },
  }
}

describe('autonomy sync store', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(async () => {
    await Promise.all(stores.map(store => store.clear()))
    synchronize.mockClear()
    pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().user = { id: 'user-1', name: 'user-1', email: 'user-1@example.test', emailVerified: true, createdAt: new Date(), updatedAt: new Date() }
  })

  afterEach(async () => {
    disposePinia(pinia)
    await Promise.all(stores.map(store => store.clear()))
  })

  it('sends reminders and intentions but not small talk, and applies a remote intention', async () => {
    const missions = useMissionsStore()
    const intentions = useIntentionsStore()
    const reminder = await missions.addReminder({ text: 'medicine time', start: { kind: 'after', minutes: 60 }, repeat: { kind: 'once' } }, 'session-1')
    await missions.addSmallTalk({ minutes: 30 }, 'session-1')
    const intention = await intentions.add({ text: 'Ask about the trip', hours: 24 })
    if (!reminder.ok || !intention.ok)
      throw new Error('The test records were refused')
    const remote = { id: 'remote', text: 'Ask about the cat', createdAt: Date.now(), expiresAt: Date.now() + 60_000 }
    synchronize.mockImplementationOnce(async (options) => {
      expect(Object.keys(options.readLocal()).sort()).toEqual([intention.intention.id, reminder.mission.id].sort())
      await options.applyLocal({ upserts: { remote: { kind: 'intention', record: remote } }, removals: [], conflictCopies: [] })
      return { state: { documents: {} }, refused: [] }
    })
    useFeatureFlagsStore().setPreference('memory-sync', true)

    useAutonomySyncStore().initialize(leaderRuntime())

    await vi.waitFor(() => expect(intentions.intentions.map(item => item.id)).toContain('remote'))
    expect(synchronize).toHaveBeenCalledTimes(1)
  })
})
