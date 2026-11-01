import type { ChatHistoryItem, TopicLine, TopicSeed } from '@proj-airi/core-agent'

import type { MemoryEntry } from '../../types/memory'

import { extractMessageText } from '../chat-sync/wire-message'
import { memoryIndexEntries } from '../memory-index'
import { INITIATIVE_SOURCE } from './conversation'

/**
 * Reads the autonomous lines of one conversation from `since` on, oldest first.
 *
 * Use when:
 * - The initiative runner finds the current thread, the recent topics, and the variety of the lines.
 *
 * Returns:
 * - Each line with its topic label, its time, and whether the owner wrote before the next autonomous line.
 *   Topic history needs no storage of its own, because each reply keeps its label.
 */
export function initiativeTopicLines(messages: readonly ChatHistoryItem[], since: number): TopicLine[] {
  const lines: TopicLine[] = []
  let open: { text: string, label?: string, at: number, answered: boolean } | undefined
  const close = () => {
    if (open)
      lines.push(open)
    open = undefined
  }
  for (const message of messages) {
    if (message.role === 'user' && !message.notice && open) {
      open.answered = true
      continue
    }
    if (message.role !== 'assistant' || message.proactive?.source !== INITIATIVE_SOURCE)
      continue
    close()
    const text = extractMessageText(message).trim()
    if (!text || (message.createdAt ?? 0) < since)
      continue
    open = { text, ...(message.topic ? { label: message.topic } : {}), at: message.createdAt ?? 0, answered: false }
  }
  close()
  return lines
}

/**
 * Seeds from the memory index of a card: the description line of each listed entry.
 * The index already holds what matters most now, so the seeds follow the same 50 entries.
 */
export function memoryTopicSeeds(entries: readonly MemoryEntry[], personaId: string): TopicSeed[] {
  const { own, general } = memoryIndexEntries(entries, personaId)
  return [...own, ...general].map(entry => ({ text: entry.description, source: 'memory' }))
}
