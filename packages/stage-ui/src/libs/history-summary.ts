import type { ChatHistoryItem, Conversation } from '@proj-airi/core-agent'

import type { ChatHistorySummary } from '../types/chat-session'

import { extractMessageText } from './chat-sync'

/**
 * The limits of the history that a request sends as it is.
 * Summaries move in large steps, so the cached prefix of the request changes only every few dozen messages.
 */
export const HISTORY_SUMMARY_LIMITS = {
  /** More messages after the summary than this start a new summary. */
  maxRecentMessages: 60,
  /** More characters after the summary than this start a new summary. */
  maxRecentChars: 40_000,
  /** A new summary leaves about this many recent messages as they are. */
  keepMessages: 20,
  /** The longest summary that the model can write. */
  maxSummaryChars: 1_500,
  /** The summary request reads at most this much of one message. */
  maxMessageChars: 2_000,
}

/**
 * The characters that a message adds to a request, about. A reply with a generation transcript goes out as that
 * transcript, with its tool calls and results, so its size counts.
 */
export function messageChars(message: ChatHistoryItem) {
  if (message.role === 'assistant' && message.generationTranscript)
    return JSON.stringify(message.generationTranscript).length
  const toolResults = message.role === 'assistant' && message.tool_results?.length ? JSON.stringify(message.tool_results).length : 0
  return extractMessageText(message).length + toolResults
}

/**
 * The history that a request sends: the messages after the summary, and the summary text.
 * A summary whose last message is gone, for example after a delete, no longer fits, so the whole history goes out.
 */
export function projectSummarizedHistory(messages: ChatHistoryItem[], summary?: ChatHistorySummary) {
  const through = summary ? messages.findIndex(message => message.id === summary.throughMessageId) : -1
  if (!summary || through < 0)
    return { messages, coveredCount: 0 }
  return { messages: messages.slice(through + 1), summary: summary.text, coveredCount: through + 1 }
}

/**
 * Decides whether the history needs a new summary. It returns the messages to fold into the summary, or undefined.
 * The recent history never starts with a tool result, because its call would be in the summary. It can start with a
 * reply, for example autonomous speech, because the summary goes before it as a user-level message.
 */
export function planHistorySummary(messages: ChatHistoryItem[], summary?: ChatHistorySummary) {
  const { messages: recent, coveredCount } = projectSummarizedHistory(messages, summary)
  const chars = recent.reduce((sum, message) => sum + messageChars(message), 0)
  if (recent.length <= HISTORY_SUMMARY_LIMITS.maxRecentMessages && chars <= HISTORY_SUMMARY_LIMITS.maxRecentChars)
    return undefined

  let cut = Math.max(1, recent.length - HISTORY_SUMMARY_LIMITS.keepMessages)
  while (cut > 1 && recent[cut]?.role === 'tool')
    cut -= 1
  const fold = recent.slice(0, cut)
  const through = fold.at(-1)
  if (!through?.id)
    return undefined
  return { fold, throughMessageId: through.id, coveredCount: coveredCount + fold.length, previous: coveredCount > 0 ? summary?.text : undefined }
}

function speakerOf(message: ChatHistoryItem) {
  if (message.role === 'user')
    return message.notice ? `Notice from ${message.notice.source}` : 'Owner'
  return message.role === 'assistant' ? 'You' : undefined
}

/** The request that asks the chat model for a new summary: the earlier summary and the messages to fold. */
export function historySummaryRequest(plan: NonNullable<ReturnType<typeof planHistorySummary>>): Conversation {
  const transcript = plan.fold.flatMap((message) => {
    const speaker = speakerOf(message)
    const text = extractMessageText(message).trim().slice(0, HISTORY_SUMMARY_LIMITS.maxMessageChars)
    return speaker && text ? [`${speaker}: ${text}`] : []
  }).join('\n')
  const instruction = [
    'You keep the memory of a long conversation between the owner and you, the character.',
    `Write one summary of the earlier summary and the new messages, in at most ${HISTORY_SUMMARY_LIMITS.maxSummaryChars} characters.`,
    'Keep facts about the owner, promises, plans, open questions, the topics, and how the owner felt. Leave out greetings and small talk without facts.',
    'Write in the language of the conversation. Write the summary only, without a heading.',
  ].join('\n')
  return {
    turns: [
      { type: 'system', id: 'history-summary-instruction', authority: 'system', content: [{ type: 'text', text: instruction }] },
      {
        type: 'user',
        id: 'history-summary-input',
        content: [{ type: 'text', text: `${plan.previous ? `Earlier summary:\n${plan.previous}\n\n` : ''}New messages:\n${transcript}` }],
      },
    ],
  }
}
