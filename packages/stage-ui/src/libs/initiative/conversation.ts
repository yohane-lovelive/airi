import type { ChatHistoryItem, InitiativeEvent } from '@proj-airi/core-agent'

import { INITIATIVE_RECENT_LINE_COUNT } from '@proj-airi/core-agent'

import { extractMessageText } from '../chat-sync/wire-message'

/** The notice source of autonomous turns. The replies of these turns carry it as their proactive source. */
export const INITIATIVE_SOURCE = 'initiative'

/** What the situation block reads from one conversation. */
export interface InitiativeConversationFacts {
  lastOwnerAt?: number
  lastSpokeAt?: number
  /** The last lines that the character started on its own, oldest first. */
  recentLines: string[]
}

/**
 * Reads the facts of the situation block from the stored messages of one conversation.
 *
 * Use when:
 * - The initiative runner builds the notice of an autonomous turn.
 *
 * Returns:
 * - The time of the last owner message, the time of the last character line, and the last autonomous lines.
 */
export function initiativeConversationFacts(messages: readonly ChatHistoryItem[]): InitiativeConversationFacts {
  const lastOwner = messages.findLast(message => message.role === 'user' && !message.notice)
  const lastSpoke = messages.findLast(message => message.role === 'assistant')
  const recentLines = messages
    .filter(message => message.role === 'assistant' && message.proactive?.source === INITIATIVE_SOURCE)
    .slice(-INITIATIVE_RECENT_LINE_COUNT)
    .map(message => extractMessageText(message).trim())
    .filter(Boolean)
  return {
    ...(lastOwner?.createdAt !== undefined ? { lastOwnerAt: lastOwner.createdAt } : {}),
    ...(lastSpoke?.createdAt !== undefined ? { lastSpokeAt: lastSpoke.createdAt } : {}),
    recentLines,
  }
}

/**
 * Tells what a newly stored message means for the initiative policy.
 *
 * - An owner message is `owner-message`. A notice is not owner speech, so it is not one.
 * - A character reply that no autonomous turn started is `character-spoke`, for example a reply to the owner.
 *   The policy closes its own turns with `turn-finished`, so their replies count for nothing here.
 *
 * Returns `undefined` for every other message.
 */
export function initiativeEventOf(message: ChatHistoryItem): InitiativeEvent | undefined {
  if (message.role === 'user')
    return message.notice ? undefined : { type: 'owner-message' }
  if (message.role === 'assistant' && message.proactive?.source !== INITIATIVE_SOURCE)
    return { type: 'character-spoke' }
  return undefined
}
