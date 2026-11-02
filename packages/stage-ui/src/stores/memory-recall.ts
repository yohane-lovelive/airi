import type { MemoryRecallHit, MemoryRecallMode, MemoryRecallResult } from '../libs/memory-recall'

import { defineStore } from 'pinia'
import { array, number, object, parse, string } from 'valibot'
import { ref } from 'vue'

import { authedFetch } from '../libs/auth-fetch'
import { recallMemories } from '../libs/memory-recall'
import { SERVER_URL } from '../libs/server'
import { useMemoryStore } from './memory'
import { useMemorySyncStore } from './memory-sync'

const SEARCH_PATH = '/api/v1/memories/search'

const SearchResponseSchema = object({
  records: array(object({ id: string(), score: number() })),
})

/** The last recall, for the inspector. It holds no memory text. */
export interface LastMemoryRecall {
  at: number
  mode: MemoryRecallMode
  count: number
  queryChars: number
}

/**
 * Recalls the memories that fit a text, by meaning on the server while the memory sync runs, and by shared characters
 * otherwise. Every reader of memories uses it: the chat reply, `builtIn_searchMemory`, and the autonomous readers.
 *
 * Use when:
 * - A request needs the entries of a card that fit a text.
 *
 * Returns:
 * - `recall`, and `lastRecall` that every window can read.
 */
export const useMemoryRecallStore = defineStore('memory-recall', () => {
  const memory = useMemoryStore()
  const memorySync = useMemorySyncStore()
  const lastRecall = ref<LastMemoryRecall>()

  async function searchOnServer(query: string, personaId: string, limit: number, signal: AbortSignal): Promise<MemoryRecallHit[]> {
    // The server URL can have a path, so the route joins it as the document sync does.
    const url = new URL(SERVER_URL)
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${SEARCH_PATH}`
    const response = await authedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query.slice(0, 500), personaId, limit }),
      signal,
    })
    // A 503 means that the server runs no embedder. The recall then uses shared characters.
    if (!response.ok)
      throw new Error(`Memory search answered ${response.status}`)
    return parse(SearchResponseSchema, await response.json()).records
  }

  /** The entries of the card and the general entries that best fit `query`, best first. */
  async function recall(query: string, personaId: string, limit = 5): Promise<MemoryRecallResult> {
    await memory.ready()
    const result = await recallMemories({
      query,
      personaId,
      limit,
      entries: memory.entries,
      ...(memorySync.active
        ? { searchByMeaning: (signal: AbortSignal) => searchOnServer(query, personaId, limit, signal), syncedAt: memorySync.lastSyncedAt }
        : {}),
    })
    lastRecall.value = { at: Date.now(), mode: result.mode, count: result.entries.length, queryChars: query.length }
    return result
  }

  return {
    lastRecall,
    recall,
  }
}, {
  synced: {
    state: true,
  },
})
