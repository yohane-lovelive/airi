import type { ChatHistoryItem } from '@proj-airi/core-agent'

import { describe, expect, it } from 'vitest'

import { HISTORY_SUMMARY_LIMITS, historySummaryRequest, messageChars, planHistorySummary, projectSummarizedHistory } from './history-summary'

/** A conversation of `turns` owner messages, each with one reply. Ids are `u0`, `a0`, `u1`, and so on. */
function conversation(turns: number, text = 'hello'): ChatHistoryItem[] {
  return Array.from({ length: turns }, (_, index) => [
    { role: 'user', id: `u${index}`, content: `${text} ${index}` },
    { role: 'assistant', id: `a${index}`, content: `reply ${index}`, slices: [{ type: 'text', text: `reply ${index}` }], tool_results: [] },
  ] as ChatHistoryItem[]).flat()
}

const summary = (throughMessageId: string, coveredCount: number) => ({ text: 'Earlier talk.', throughMessageId, coveredCount, createdAt: 0 })

describe('history summary', () => {
  it('sends the messages after the summary, and the whole history without one', () => {
    const messages = conversation(3)

    expect(projectSummarizedHistory(messages)).toEqual({ messages, coveredCount: 0 })
    expect(projectSummarizedHistory(messages, summary('a0', 2))).toEqual({ messages: messages.slice(2), summary: 'Earlier talk.', coveredCount: 2 })
  })

  // A delete can remove the last message of the summary. The summary then no longer fits, and nothing may go missing.
  it('sends the whole history when the last message of the summary is gone', () => {
    const messages = conversation(3)

    expect(projectSummarizedHistory(messages, summary('gone', 2))).toEqual({ messages, coveredCount: 0 })
  })

  it('waits until the recent history passes its limits', () => {
    expect(planHistorySummary(conversation(HISTORY_SUMMARY_LIMITS.maxRecentMessages / 2))).toBeUndefined()
    expect(planHistorySummary(conversation(2, 'x'.repeat(HISTORY_SUMMARY_LIMITS.maxRecentChars)))).toBeDefined()
  })

  it('keeps the recent messages and folds the rest', () => {
    const messages = conversation(HISTORY_SUMMARY_LIMITS.maxRecentMessages / 2 + 1)
    const plan = planHistorySummary(messages)

    expect(plan?.fold).toEqual(messages.slice(0, messages.length - HISTORY_SUMMARY_LIMITS.keepMessages))
    expect(plan?.throughMessageId).toBe(messages.at(-HISTORY_SUMMARY_LIMITS.keepMessages - 1)?.id)
    expect(plan?.previous).toBeUndefined()
  })

  // Autonomous speech makes long runs of replies without an owner message. The recent part must stay short there too.
  it('keeps the same count in a run of replies, but never starts the recent part with a tool result', () => {
    const replies = Array.from({ length: HISTORY_SUMMARY_LIMITS.maxRecentMessages + 1 }, (_, index) => (
      { role: 'assistant', id: `a${index}`, content: `line ${index}`, slices: [], tool_results: [] }
    )) as ChatHistoryItem[]
    expect(planHistorySummary(replies)?.fold).toHaveLength(replies.length - HISTORY_SUMMARY_LIMITS.keepMessages)

    const cutAt = replies.length - HISTORY_SUMMARY_LIMITS.keepMessages
    const withTool = replies.map((message, index) => index === cutAt ? { role: 'tool', id: 'tool', content: 'result', tool_call_id: 'call' } as ChatHistoryItem : message)
    expect(planHistorySummary(withTool)?.fold).toHaveLength(cutAt - 1)
  })

  // A reply goes out as its generation transcript, with tool calls and results, so the transcript is its size.
  it('counts the generation transcript of a reply', () => {
    const transcript = { type: 'assistant', id: 't', status: 'completed', rounds: [{ id: 'r', content: [{ type: 'text', text: 'x'.repeat(500) }], toolInvocations: [], projectionIssues: [] }] }
    const reply = { role: 'assistant', id: 'a', content: 'short', slices: [], tool_results: [], generationTranscript: transcript } as ChatHistoryItem

    expect(messageChars(reply)).toBe(JSON.stringify(transcript).length)
  })

  it('counts the messages after the earlier summary, and folds the earlier summary into the new one', () => {
    const messages = conversation(HISTORY_SUMMARY_LIMITS.maxRecentMessages)
    const plan = planHistorySummary(messages, summary('a9', 20))

    expect(plan?.previous).toBe('Earlier talk.')
    expect(plan?.fold[0]?.id).toBe('u10')
    expect(plan?.coveredCount).toBe(20 + (plan?.fold.length ?? 0))
    const request = JSON.stringify(historySummaryRequest(plan!))
    expect(request).toContain('Earlier summary:\\nEarlier talk.')
    expect(request).toContain('Owner: hello 10')
    expect(request).toContain('You: reply 10')
  })
})
