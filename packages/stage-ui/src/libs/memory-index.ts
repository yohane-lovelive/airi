import type { MemoryEntry } from '../types/memory'

import { characterBigrams } from '@proj-airi/core-agent'

/** The memory index of a request lists at most this many entries. The model searches the rest. */
export const MEMORY_INDEX_LIMIT = 50
/** The index while the memory sync runs. Recall by meaning brings the older entries that fit with the owner message. */
export const MEMORY_INDEX_LIMIT_WITH_RECALL = 20
/** A memory search returns at most this many entries. */
export const MEMORY_SEARCH_LIMIT = 5

function newestFirst(left: MemoryEntry, right: MemoryEntry) {
  return right.updatedAt - left.updatedAt
}

/**
 * The entries that the index of a card lists: its own entries, then general ones, each group newest first.
 * The list stops at `limit`, {@link MEMORY_INDEX_LIMIT} by default. `hidden` counts the entries that it leaves out.
 */
export function memoryIndexEntries(entries: readonly MemoryEntry[], personaId: string, limit = MEMORY_INDEX_LIMIT) {
  const own = entries.filter(entry => entry.persona === personaId).sort(newestFirst)
  const general = entries.filter(entry => !entry.persona).sort(newestFirst)
  const listedOwn = own.slice(0, limit)
  const listedGeneral = general.slice(0, limit - listedOwn.length)
  return { own: listedOwn, general: listedGeneral, hidden: own.length + general.length - listedOwn.length - listedGeneral.length }
}

/**
 * Finds the entries that share the most character pairs with the query, best first. A tie goes to the newer entry.
 *
 * @example
 * searchMemories(entries, '誕生日')
 * // => the entries whose description or body holds "誕生" or "生日"
 */
export function searchMemories(entries: readonly MemoryEntry[], query: string, limit = MEMORY_SEARCH_LIMIT) {
  const wanted = characterBigrams(query)
  if (!wanted.size)
    return []
  return entries
    .map((entry) => {
      const text = `${entry.description}\n${entry.body}`.toLowerCase().replace(/\s+/g, '')
      let hits = 0
      for (const bigram of wanted) {
        if (text.includes(bigram))
          hits += 1
      }
      return { entry, score: hits / wanted.size }
    })
    .filter(result => result.score > 0)
    .sort((left, right) => right.score - left.score || newestFirst(left.entry, right.entry))
    .slice(0, limit)
    .map(result => result.entry)
}
