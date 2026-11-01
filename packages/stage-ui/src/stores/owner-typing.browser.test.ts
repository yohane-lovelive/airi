import type { LeadershipMode, SyncedPiniaRuntime } from 'pinia-plugin-synced'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { createSyncedPiniaPlugin } from 'pinia-plugin-synced'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { isOwnerTyping } from '../libs/initiative/typing'
import { useOwnerTypingStore } from './owner-typing'

const contexts: Array<{ pinia: ReturnType<typeof createPinia>, runtime: SyncedPiniaRuntime }> = []

function createWindow(namespace: string, leadership: LeadershipMode) {
  const pinia = createPinia()
  const runtime = createSyncedPiniaPlugin({ callTimeout: 1000, leadership, namespace })
  pinia.use(runtime.plugin)
  createApp({}).use(pinia)
  contexts.push({ pinia, runtime })
  setActivePinia(pinia)
  return { runtime, store: useOwnerTypingStore() }
}

async function createWindows() {
  const namespace = `owner-typing:${crypto.randomUUID()}`
  const leader = createWindow(namespace, 'leader-only')
  await vi.waitFor(() => expect(leader.runtime.isLeader()).toBe(true))
  const follower = createWindow(namespace, 'follower-only')
  await vi.waitFor(() => expect(follower.runtime.getLeaderId()).toBe(leader.runtime.participantId))
  return { leader, follower }
}

function proposalsOf(traffic: { mock: { calls: unknown[][] } }) {
  // replaceState is the plugin's follower-to-leader proposal RPC.
  return traffic.mock.calls.filter(([message]) => JSON.stringify(message).includes('replaceState'))
}

describe('useOwnerTypingStore', () => {
  afterEach(() => {
    for (const context of contexts.splice(0)) {
      context.runtime.dispose()
      disposePinia(context.pinia)
    }
    vi.restoreAllMocks()
  })

  it('shows typing in a chat window to the leader, and its end too', async () => {
    const { leader, follower } = await createWindows()

    follower.store.report()

    await expect.poll(() => isOwnerTyping(leader.store.typingUntil, Date.now())).toBe(true)

    follower.store.clear()

    await expect.poll(() => leader.store.typingUntil).toBe(0)
  })

  it('writes once for each refresh time, however often the owner types', async () => {
    const { leader, follower } = await createWindows()
    let leaderMutations = 0
    leader.store.$subscribe(() => leaderMutations += 1, { flush: 'sync' })

    follower.store.report()
    follower.store.report()
    follower.store.report()

    await expect.poll(() => leader.store.typingUntil).not.toBe(0)
    expect(leaderMutations).toBe(1)
  })

  it('does not send a proposal back after a remote snapshot arrives', async () => {
    const { leader, follower } = await createWindows()
    const traffic = vi.spyOn(BroadcastChannel.prototype, 'postMessage')

    leader.store.report()

    await expect.poll(() => follower.store.typingUntil).toBe(leader.store.typingUntil)
    expect(proposalsOf(traffic)).toHaveLength(0)
  })
})
