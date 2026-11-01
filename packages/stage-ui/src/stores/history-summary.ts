import type { ChatHistoryItem } from '@proj-airi/core-agent'

import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'

import { useTextGeneration } from '../composables/text-generation'
import { HISTORY_SUMMARY_LIMITS, historySummaryRequest, planHistorySummary, projectSummarizedHistory } from '../libs/history-summary'
import { useChatSessionStore } from './chat/session-store'
import { useAiriCardStore } from './modules/airi-card'

/** A summary request that takes longer than this is given up. The next send tries again. */
const SUMMARY_TIMEOUT_MS = 120_000

/**
 * The summary of the older messages of each conversation, the short-term memory of the character.
 *
 * Requests send the summary and the recent messages, not the whole history. After each send, `summarize` checks the
 * history, and when the recent part grew past its limits, the chat model of the session writes a new summary in the
 * background. Until it is ready, requests send the history as before. The chat view always shows the whole history.
 *
 * Use when:
 * - The chat store builds a request. Call `project` for the history to send.
 * - A send of a session finished. Call `summarize`.
 */
export const useHistorySummaryStore = defineStore('history-summary', () => {
  const enabled = useLocalStorageManualReset<boolean>('settings/memory/history-summary', true)
  const chatSession = useChatSessionStore()
  const cardStore = useAiriCardStore()
  const { generateText } = useTextGeneration()
  /** Sessions with a summary request in flight. One request for each session is enough. */
  const running = new Set<string>()

  /** The history to send for a session: the messages after its summary, and the summary. Off, it is the whole history. */
  function project(sessionId: string, messages: ChatHistoryItem[]) {
    return projectSummarizedHistory(messages, enabled.value ? chatSession.sessionMetas[sessionId]?.historySummary : undefined)
  }

  /** Writes a new summary when the recent history grew past its limits. A failure only logs, and the next send tries again. */
  async function summarize(sessionId: string) {
    const meta = chatSession.sessionMetas[sessionId]
    if (!enabled.value || !meta || running.has(sessionId))
      return
    const plan = planHistorySummary(chatSession.getSessionMessages(sessionId), meta.historySummary)
    if (!plan)
      return
    const { provider, model } = cardStore.getModules(meta.characterId).consciousness
    if (!provider || !model)
      return

    running.add(sessionId)
    try {
      const text = (await generateText({ providerId: provider, model }, 'history-summary')(historySummaryRequest(plan), AbortSignal.timeout(SUMMARY_TIMEOUT_MS))).trim()
      // The history can change while the model writes, for example by a delete. A summary of gone messages must not land.
      if (!text || !chatSession.getSessionMessages(sessionId).some(message => message.id === plan.throughMessageId))
        return
      await chatSession.setSessionHistorySummary(sessionId, {
        // The model can write past the asked length. The cap keeps a long answer from filling every later request.
        text: text.slice(0, HISTORY_SUMMARY_LIMITS.maxSummaryChars * 2),
        throughMessageId: plan.throughMessageId,
        coveredCount: plan.coveredCount,
        createdAt: Date.now(),
      })
    }
    catch (error) {
      console.warn('[history-summary] Failed to summarize the history:', errorMessageFrom(error))
    }
    finally {
      running.delete(sessionId)
    }
  }

  function resetState() {
    enabled.reset()
  }

  return {
    enabled,
    project,
    summarize,
    resetState,
  }
})
