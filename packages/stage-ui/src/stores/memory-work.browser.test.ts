import type { ChatHistoryItem, Conversation } from '@proj-airi/core-agent'
import type { Tool } from '@xsai/shared-chat'
import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { prefixStorage } from 'unstorage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { storage } from '../database/storage'
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
  prefixStorage(storage, 'memory'),
  prefixStorage(storage, 'owner-profile'),
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
    localStorage.removeItem('memory/merge-checked-at')
    localStorage.removeItem('memory/merge-distinct')
    localStorage.removeItem('memory/recent-merges')
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

  it('merges the entries of the card that say the same thing into the newest one', async () => {
    const memory = useMemoryStore()
    const older = await memory.write({ description: '好きな食べ物', body: 'オーナーはラーメンが好き' }, 'airi')
    await new Promise(resolve => setTimeout(resolve, 5))
    const newer = await memory.write({ description: '好きな食べ物', body: 'オーナーはラーメンが大好き' }, 'airi')
    const general = await memory.write({ description: '好きな食べ物', body: 'オーナーはラーメンが好き' }, 'other-card')
    generate.mockImplementation(async (_request, _signal, tools) => {
      await tools![0].execute({ pairs: [{ ids: [older!.id, newer!.id], merged: { description: '好きな食べ物', body: 'オーナーはラーメンが大好き。' } }] }, { messages: [], toolCallId: 'call-1' })
      return ''
    })

    const merged = await useMemoryWorkStore().mergeNow()

    expect(merged).toBe(1)
    expect(generate).toHaveBeenCalledTimes(1)
    const left = memory.entries.filter(entry => entry.persona === 'airi')
    expect(left.map(entry => [entry.id, entry.body])).toEqual([[newer!.id, 'オーナーはラーメンが大好き。']])
    // The entry of another card takes no part.
    expect(memory.entries.some(entry => entry.id === general!.id)).toBe(true)
    expect(useMemoryWorkStore().recentMerges).toEqual([expect.objectContaining({ before: ['好きな食べ物', '好きな食べ物'], after: '好きな食べ物' })])
  })

  // ROOT CAUSE:
  // A merge sent 3 groups and moved its start past every checked entry, so a live check left 6 copies unmerged.
  // The next merge now starts at the first entry of a pair that waits.
  it('merges every copy over later merges when one merge cannot send all pairs', async () => {
    const memory = useMemoryStore()
    const facts = [
      ['りんご農園', '週末にりんご農園を見学した', '週末、りんご農園を見学した'],
      ['自転車', '新しいロードバイクを買った', '新品のロードバイクを買った'],
      ['ピアノ', '子どものころピアノを習っていた', '子供のころにピアノを習っていた'],
      ['引っ越し', '来月に横浜へ引っ越す', '来月、横浜に引っ越す'],
      ['資格', '基本情報技術者試験に合格した', '基本情報技術者の試験に合格した'],
    ]
    for (const [description, ...bodies] of facts) {
      for (const body of bodies) {
        await memory.write({ description, body }, 'airi')
        await new Promise(resolve => setTimeout(resolve, 2))
      }
    }
    generate.mockImplementation(async (request, _signal, tools) => {
      // The fake merges every group that the request lists. Each line of a group starts with the id of its entry.
      const input = request.turns.at(-1) as { content: { text: string }[] }
      const blocks = input.content[0].text.split('\n\n').map(block => block.split('\n').slice(1))
      await tools![0].execute({
        pairs: blocks.map(lines => ({
          ids: lines.map(line => line.slice(2, line.indexOf(' (', 2))),
          merged: { description: 'merged', body: lines[0].slice(lines[0].indexOf('): ') + 3) },
        })),
      }, { messages: [], toolCallId: 'call-1' })
      return ''
    })
    const work = useMemoryWorkStore()

    let merged = 0
    for (let round = 0; round < 4; round++)
      merged += await work.mergeNow()

    expect(merged).toBe(facts.length)
    expect(memory.entries.filter(entry => entry.persona === 'airi')).toHaveLength(facts.length)
  })

  it('keeps entries that the model judged as different facts, and does not ask about them again', async () => {
    const memory = useMemoryStore()
    const first = await memory.write({ description: '週末の予定', body: '土曜日に大阪へ行く' }, 'airi')
    const second = await memory.write({ description: '週末の予定', body: '日曜日に大阪へ行く' }, 'airi')
    generate.mockImplementation(async (_request, _signal, tools) => {
      await tools![0].execute({ pairs: [{ ids: [first!.id, second!.id], merged: null }] }, { messages: [], toolCallId: 'call-1' })
      return ''
    })
    const work = useMemoryWorkStore()

    expect(await work.mergeNow()).toBe(0)
    // A later change of the entry makes it a checked entry again, but the pair stays apart.
    await memory.write({ id: second!.id, description: '週末の予定', body: '日曜日に大阪へ行く予定' }, 'airi')
    expect(await work.mergeNow()).toBe(0)

    expect(generate).toHaveBeenCalledTimes(1)
    expect(memory.entries.filter(entry => entry.persona === 'airi')).toHaveLength(2)
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
