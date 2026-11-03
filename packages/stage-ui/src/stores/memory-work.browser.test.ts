import type { ChatHistoryItem, Conversation } from '@proj-airi/core-agent'
import type { Tool } from '@xsai/shared-chat'
import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import localforage from 'localforage'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useMemoryStore } from './memory'
import { useMemoryWorkStore } from './memory-work'
import { useOwnerProfileStore } from './owner-profile'

const MINUTE = 60_000

const { conversation, generate } = vi.hoisted(() => ({
  conversation: { messages: [] as ChatHistoryItem[] },
  generate: vi.fn<(request: Conversation, signal?: AbortSignal, tools?: Tool[]) => Promise<string>>(),
}))

// The model is the boundary. The fake answers the report tool, or writes the profile.
vi.mock('../composables/text-generation', () => ({
  useTextGeneration: () => ({ generateText: () => generate }),
}))
vi.mock('./chat', () => ({ useChatStore: () => ({ personaOf: () => 'airi' }) }))
vi.mock('./chat/session-store', () => ({
  useChatSessionStore: () => ({
    activeSessionId: 'session-1',
    sessionMetas: { 'session-1': { characterId: 'airi' } },
    getSessionMessages: () => conversation.messages,
  }),
}))
vi.mock('./modules/airi-card', () => ({
  useAiriCardStore: () => ({ activeCardId: 'airi', getModules: () => ({ consciousness: { provider: 'provider', model: 'model' } }) }),
}))

const stores = [
  localforage.createInstance({ name: 'airi-memory', storeName: 'entries' }),
  localforage.createInstance({ name: 'airi-owner-profile', storeName: 'profile' }),
]

function leaderRuntime(): Pick<SyncedPiniaRuntime, 'isLeader' | 'onLeadershipChange'> {
  return {
    isLeader: () => true,
    onLeadershipChange: (listener) => {
      listener(true)
      return () => {}
    },
  }
}

function owner(text: string, createdAt: number): ChatHistoryItem {
  return { role: 'user', content: text, createdAt, id: `user-${createdAt}` }
}

describe('memory work store', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(async () => {
    await Promise.all(stores.map(store => store.clear()))
    localStorage.removeItem('memory/work-enabled')
    localStorage.removeItem('memory/work-through')
    localStorage.removeItem('memory/owner-profile-enabled')
    generate.mockReset()
    generate.mockImplementation(async (_request, _signal, tools) => {
      if (tools?.length)
        await tools[0].execute({ entries: [{ id: null, description: '旅行の予定', body: '来週、大阪へ旅行する' }] }, { messages: [], toolCallId: 'call-1' })
      return tools?.length ? '' : '大阪旅行を控えている。'
    })
    conversation.messages = [owner('来週大阪に行くよ', Date.now() - 30 * MINUTE)]
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(async () => {
    disposePinia(pinia)
    await Promise.all(stores.map(store => store.clear()))
  })

  it('does nothing while the setting is off', async () => {
    const work = useMemoryWorkStore()
    work.initialize(leaderRuntime())

    await work.tick()

    expect(generate).not.toHaveBeenCalled()
  })

  it('saves the reported facts once for a finished part, and writes the profile when it is on', async () => {
    const work = useMemoryWorkStore()
    work.enabled = true
    useOwnerProfileStore().enabled = true
    work.initialize(leaderRuntime())

    await work.tick()
    await work.tick()

    expect(useMemoryStore().entries.map(entry => entry.body)).toEqual(['来週、大阪へ旅行する'])
    expect(useOwnerProfileStore().profile?.text).toBe('大阪旅行を控えている。')
    expect(work.lastWork).toMatchObject({ written: 1, profileWritten: true })
    // The second tick finds no new owner words after the covered message.
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('waits 30 minutes after a failed pass', async () => {
    generate.mockRejectedValue(new Error('provider down'))
    const work = useMemoryWorkStore()
    work.enabled = true
    work.initialize(leaderRuntime())

    await work.tick()
    await work.tick()

    expect(generate).toHaveBeenCalledTimes(1)
    expect(work.lastWork).toMatchObject({ failed: true })
  })
})
