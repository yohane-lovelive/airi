import type { Conversation } from '@proj-airi/core-agent'

/** The turn id of the history summary. The chat runtime gives it this id. */
const HISTORY_SUMMARY_TURN_ID = 'history-summary'

/**
 * The size of each part of a request, in characters, for IO traces. A trace then shows which part holds too much.
 *
 * - `systemChars`: the system prompt, with the persona, the memory index, and the format rules.
 * - `summaryChars`: the summary of the older messages.
 * - `historyTurns` and `historyChars`: the other turns. Their size counts the serialized turn, so it is an upper bound.
 */
export function promptPartSizes(conversation: Conversation) {
  const sizes = { systemChars: 0, summaryChars: 0, historyTurns: 0, historyChars: 0 }
  for (const turn of conversation.turns) {
    if (turn.type === 'system' && turn.id === HISTORY_SUMMARY_TURN_ID) {
      sizes.summaryChars += turn.content.reduce((sum, segment) => sum + ('text' in segment ? segment.text.length : 0), 0)
    }
    else if (turn.type === 'system' && turn.authority === 'system') {
      sizes.systemChars += turn.content.reduce((sum, segment) => sum + (segment.type === 'text' ? segment.text.length : JSON.stringify(segment).length), 0)
    }
    else {
      sizes.historyTurns += 1
      sizes.historyChars += JSON.stringify(turn).length
    }
  }
  return sizes
}
