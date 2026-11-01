import type { ChatHistoryItem } from '@proj-airi/core-agent'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { HISTORY_SUMMARY_LIMITS } from '../libs/history-summary'
import { useHistorySummaryStore } from './history-summary'

const { session, generate } = vi.hoisted(() => ({
  session: {
    messages: [] as ChatHistoryItem[],
    sessionMetas: {} as Record<string, { characterId: string, historySummary?: unknown }>,
    setSessionHistorySummary: vi.fn(async () => true),
  },
  generate: vi.fn(async () => 'The owner planned a trip.'),
}))

vi.mock('./chat/session-store', () => ({
  useChatSessionStore: () => ({ ...session, getSessionMessages: () => session.messages }),
}))
vi.mock('./modules/airi-card', () => ({
  useAiriCardStore: () => ({ getModules: () => ({ consciousness: { provider: 'provider', model: 'model' } }) }),
}))
vi.mock('../composables/text-generation', () => ({
  useTextGeneration: () => ({ generateText: () => generate }),
}))

describe('history summary store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // One turn more than the limit allows, so the history needs a summary.
    session.messages = Array.from({ length: HISTORY_SUMMARY_LIMITS.maxRecentMessages / 2 + 1 }, (_, index) => [
      { role: 'user', id: `u${index}`, content: `hello ${index}` },
      { role: 'assistant', id: `a${index}`, content: `reply ${index}`, slices: [{ type: 'text', text: `reply ${index}` }], tool_results: [] },
    ] as ChatHistoryItem[]).flat()
    session.sessionMetas = { s: { characterId: 'airi' } }
    session.setSessionHistorySummary.mockClear()
    generate.mockClear()
  })

  it('stores a summary of the older messages after the history grew past its limits', async () => {
    await useHistorySummaryStore().summarize('s')

    expect(generate).toHaveBeenCalledOnce()
    expect(session.setSessionHistorySummary).toHaveBeenCalledWith('s', expect.objectContaining({
      text: 'The owner planned a trip.',
      throughMessageId: session.messages.at(-HISTORY_SUMMARY_LIMITS.keepMessages - 1)?.id,
    }))
  })

  // A delete while the model writes removes messages that the summary holds. Its summary must not land.
  it('drops a summary whose last message was deleted while the model wrote it', async () => {
    generate.mockImplementationOnce(async () => {
      session.messages = session.messages.slice(-HISTORY_SUMMARY_LIMITS.keepMessages)
      return 'Too late.'
    })

    await useHistorySummaryStore().summarize('s')

    expect(session.setSessionHistorySummary).not.toHaveBeenCalled()
  })

  it('writes nothing and sends the whole history while the switch is off', async () => {
    const store = useHistorySummaryStore()
    store.enabled = false
    session.sessionMetas.s!.historySummary = { text: 'Old.', throughMessageId: 'a0', coveredCount: 2, createdAt: 0 }

    await store.summarize('s')

    expect(generate).not.toHaveBeenCalled()
    expect(store.project('s', session.messages).messages).toBe(session.messages)
  })
})
