import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { useAuthStore } from './auth'
import { useFeatureFlagsStore } from './feature-flags'
import { useSettingsSyncStore } from './settings-sync'

const { synchronize } = vi.hoisted(() => ({
  synchronize: vi.fn(async () => ({ state: { documents: {} }, refused: [] as string[] })),
}))

// The server exchange is the boundary. The test counts the runs.
vi.mock('../libs/document-sync', async importOriginal => ({
  ...await importOriginal<typeof import('../libs/document-sync')>(),
  synchronize,
}))

/** A leader runtime whose test can report leadership events, as the plugin does. */
function leaderRuntime() {
  let leader = true
  const listeners = new Set<(isLeader: boolean) => void>()
  const runtime: Pick<SyncedPiniaRuntime, 'isLeader' | 'onLeadershipChange'> = {
    isLeader: () => leader,
    onLeadershipChange(listener) {
      listeners.add(listener)
      listener(leader)
      return () => void listeners.delete(listener)
    },
  }
  return {
    runtime,
    report(isLeader: boolean) {
      leader = isLeader
      for (const listener of listeners)
        listener(isLeader)
    },
  }
}

/** A run reads its sync state from IndexedDB before it calls `synchronize`, so wait real time. Only `Date` is fake. */
async function settle() {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 200))
}

describe('settings sync store', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(async () => {
    localStorage.clear()
    synchronize.mockClear()
    vi.useFakeTimers({ toFake: ['Date'] })
    pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore()
    auth.user = { id: 'user-1', name: 'user-1', email: 'user-1@example.test', emailVerified: true, createdAt: new Date(), updatedAt: new Date() }
    useFeatureFlagsStore().setPreference('settings-sync', true)
    await settle()
  })

  afterEach(() => {
    disposePinia(pinia)
    vi.useRealTimers()
    localStorage.clear()
  })

  // ROOT CAUSE:
  //
  // A background tab synchronized every 2 seconds with no change. Each leadership event with `true` started a run,
  // and `initialize` started a second run at start.
  //
  // We fixed this by running on a change to leader only, at most once each 10 seconds.
  it('runs once at start and does not repeat for repeated leadership events', async () => {
    const leadership = leaderRuntime()

    useSettingsSyncStore().initialize(leadership.runtime)
    await settle()
    leadership.report(true)
    leadership.report(true)
    leadership.report(false)
    leadership.report(true)
    await settle()

    expect(synchronize).toHaveBeenCalledTimes(1)
  })

  it('pulls again after the interval when this window becomes the leader again', async () => {
    const leadership = leaderRuntime()
    useSettingsSyncStore().initialize(leadership.runtime)
    await settle()

    vi.setSystemTime(Date.now() + 10_000)
    leadership.report(false)
    leadership.report(true)
    await settle()

    expect(synchronize).toHaveBeenCalledTimes(2)
  })

  it('does not run in a follower window', async () => {
    const leadership = leaderRuntime()
    leadership.report(false)

    useSettingsSyncStore().initialize(leadership.runtime)
    await settle()

    expect(synchronize).not.toHaveBeenCalled()
  })
})
