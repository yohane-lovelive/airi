import type { LeadershipMode, SyncedPiniaRuntime } from 'pinia-plugin-synced'

import { createInitiativeState, initiativeReadout, initiativeTimeFrom, resolveInitiativeOptions } from '@proj-airi/core-agent'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { createSyncedPiniaPlugin } from 'pinia-plugin-synced'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { INSPECTOR_WATCH_HOLD_MS, useInitiativeInspectorStore } from './initiative-inspector'

const contexts: Array<{ pinia: ReturnType<typeof createPinia>, runtime: SyncedPiniaRuntime }> = []

function createWindow(namespace: string, leadership: LeadershipMode) {
  const pinia = createPinia()
  const runtime = createSyncedPiniaPlugin({ callTimeout: 1000, leadership, namespace })
  pinia.use(runtime.plugin)
  createApp({}).use(pinia)
  contexts.push({ pinia, runtime })
  setActivePinia(pinia)
  return { runtime, store: useInitiativeInspectorStore() }
}

/** The leader runs the policy. The follower stands for the settings window with the inspector. */
async function createWindows() {
  const namespace = `initiative-inspector:${crypto.randomUUID()}`
  const leader = createWindow(namespace, 'leader-only')
  await vi.waitFor(() => expect(leader.runtime.isLeader()).toBe(true))
  const follower = createWindow(namespace, 'follower-only')
  await vi.waitFor(() => expect(follower.runtime.getLeaderId()).toBe(leader.runtime.participantId))
  return { leader, follower }
}

function readout() {
  const time = initiativeTimeFrom(new Date())
  return initiativeReadout(createInitiativeState(time), { ownerActive: false, speechPlaying: false, turnRunning: false, intentions: 0 }, time, resolveInitiativeOptions())
}

describe('useInitiativeInspectorStore', () => {
  afterEach(() => {
    for (const context of contexts.splice(0)) {
      context.runtime.dispose()
      disposePinia(context.pinia)
    }
  })

  // The runner publishes only while a window watches, so a closed inspector costs nothing.
  it('tells the leader that another window watches, and the watch ends by itself', async () => {
    const { leader, follower } = await createWindows()
    expect(leader.store.isWatched(Date.now())).toBe(false)

    follower.store.markWatching()

    await expect.poll(() => leader.store.isWatched(Date.now())).toBe(true)
    expect(leader.store.isWatched(Date.now() + INSPECTOR_WATCH_HOLD_MS + 1)).toBe(false)
  })

  it('shows a readout of the leader in the watching window', async () => {
    const { leader, follower } = await createWindows()
    const published = readout()

    leader.store.publish(published, 1_000)

    await expect.poll(() => follower.store.snapshot?.at).toBe(1_000)
    expect(follower.store.snapshot?.readout).toEqual(published)
  })
})
