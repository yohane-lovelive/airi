import type { MemoryEntry } from '../types/memory'

import { characterBigrams } from '@proj-airi/core-agent'

/** The memory index of a request lists at most this many entries. The model searches the rest. */
export const MEMORY_INDEX_LIMIT = 50
/** The index while the memory sync runs. Recall by meaning brings the older entries that fit with the owner message. */
export const MEMORY_INDEX_LIMIT_WITH_RECALL = 20
/** A memory search returns at most this many entries. */
export const MEMORY_SEARCH_LIMIT = 5

/**
 * The start of the description of a memory that holds the owner's player name in one game. The game follows it, and
 * the body of the entry is the name. The memory prompt asks the character to save such a fact in this form.
 */
export const GAME_ACCOUNT_PREFIX = 'Game account:'
/** A notice lists at most this many game accounts, the newest ones. */
export const GAME_ACCOUNT_LIMIT = 8
/** The game and the name of one account are each cut to this length in a notice. */
const GAME_ACCOUNT_TEXT_LENGTH = 60

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
 * The owner's player names in games, from the memories that a card can see: its own and the general ones, newest
 * first. A turn about the screen gives them to the model, so it can find the character of the owner beside that name.
 *
 * The index of a request lists only the newest memories, and a turn about the screen recalls nothing. So this list
 * reads every entry, and an old account still reaches the turn.
 *
 * @example
 * gameAccounts([{ id: '1', description: 'Game account: League of Legends', body: 'moonrabbit', updatedAt: 1 }], 'airi')
 * // => ['League of Legends: moonrabbit']
 */
export function gameAccounts(entries: readonly MemoryEntry[], personaId: string): string[] {
  const cut = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, GAME_ACCOUNT_TEXT_LENGTH)
  return entries
    .filter(entry => (!entry.persona || entry.persona === personaId) && entry.description.trim().toLowerCase().startsWith(GAME_ACCOUNT_PREFIX.toLowerCase()))
    .sort(newestFirst)
    .map(entry => ({ game: cut(entry.description.trim().slice(GAME_ACCOUNT_PREFIX.length)), name: cut(entry.body) }))
    .filter(account => account.game && account.name)
    .slice(0, GAME_ACCOUNT_LIMIT)
    .map(account => `${account.game}: ${account.name}`)
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
