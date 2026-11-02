import type { Database } from '../../../libs/db'
import type { EmbedderClient } from '../../adapters/embedder'
import type { PushedField } from '../field-sync'

import { useLogger } from '@guiiai/logg'
import { errorMessageFrom } from '@moeru/std'
import { createBadRequestError } from '@proj-airi/http-error-shared'
import { and, eq } from 'drizzle-orm'

import { memories, memoryFields, memoryVectors } from '../../../schemas/memories'
import { createEmbedderUnavailableError } from '../../adapters/embedder'
import { createFieldSyncStore } from '../field-sync'
import { nearestMemories, refreshVectors, staleRevisions } from './vectors'

const logger = useLogger('memories')

/** The longest value of each field, as the memory tools of the client allow. */
const FIELD_LIMITS = { description: 150, body: 2_000, persona: 128 } as const
type MemoryFieldKey = keyof typeof FIELD_LIMITS

function isMemoryFieldKey(key: string): key is MemoryFieldKey {
  return Object.hasOwn(FIELD_LIMITS, key)
}

function assertMemoryFields(fields: PushedField[]) {
  const invalid: string[] = []
  for (const field of fields) {
    if (!isMemoryFieldKey(field.key)) {
      invalid.push(field.key)
      continue
    }
    if ('removed' in field)
      continue
    const minimum = field.key === 'description' ? 0 : 1
    if (typeof field.value !== 'string' || field.value.length < minimum || field.value.length > FIELD_LIMITS[field.key])
      invalid.push(field.key)
  }
  if (invalid.length > 0)
    throw createBadRequestError('Invalid memory field', 'INVALID_REQUEST', invalid)
}

/** A personal memory has some hundreds of entries after months. 5,000 entries of 2,000 characters fit. */
const MEMORY_LIMITS = { maxDocuments: 5_000, maxBytes: 16 * 1024 * 1024 }

/** Enough to undo a recent change. Memories have no history UI. */
const MEMORY_HISTORY = {
  revisionsPerKey: 5,
  deletedDocumentRetentionMs: 30 * 24 * 60 * 60 * 1000,
  maxHistoryBytes: 8 * 1024 * 1024,
}

/** A search embeds at most this many stale entries first, so one search stays short. */
export const STALE_VECTORS_PER_SEARCH = 64

export interface MemorySearch {
  query: string
  personaId: string
  limit: number
}

/**
 * Stores the long-term memories of a user, and finds them by meaning.
 *
 * Use when:
 * - A device syncs its memories, or recalls entries for a query.
 *
 * Expects:
 * - `embedder` is absent when the deployment runs no embedder. The search and embed calls then throw
 *   `503 EMBEDDER_UNAVAILABLE`, and the sync still works.
 *
 * Returns:
 * - The field store calls, and `search` and `embed`. A write embeds the changed entry in the same request. A failed
 *   embedder keeps the write, and the next search embeds the entry.
 */
export function createMemoryService(db: Database, embedder?: EmbedderClient) {
  const store = createFieldSyncStore(db, { documents: memories, fields: memoryFields }, {
    validate: assertMemoryFields,
    limits: MEMORY_LIMITS,
    history: MEMORY_HISTORY,
  })

  function requireEmbedder() {
    if (!embedder)
      throw createEmbedderUnavailableError()
    return embedder
  }

  function vectorFilter(ownerId: string) {
    return eq(memoryVectors.ownerId, ownerId)
  }

  return {
    list: store.list,

    async push(ownerId: string, documentId: string, fields: PushedField[]) {
      const result = await store.push(ownerId, documentId, fields)
      if (embedder) {
        await refreshVectors(db, embedder, ownerId, [{ documentId, revision: result.document.revision }])
          .catch(error => logger.withFields({ ownerId, documentId, error: errorMessageFrom(error) }).warn('Memory keeps an old vector'))
      }
      return result
    },

    async remove(ownerId: string, documentId: string, revision: number) {
      await store.remove(ownerId, documentId, revision)
      await db.delete(memoryVectors).where(and(vectorFilter(ownerId), eq(memoryVectors.documentId, documentId)))
    },

    async deleteAllForUser(ownerId: string) {
      await store.deleteAllForUser(ownerId)
      await db.delete(memoryVectors).where(vectorFilter(ownerId))
    },

    /** The entries of the card and the general entries that are nearest to the query, best first. */
    async search(ownerId: string, search: MemorySearch) {
      const client = requireEmbedder()
      const stale = await staleRevisions(db, ownerId, client.model, STALE_VECTORS_PER_SEARCH)
      await refreshVectors(db, client, ownerId, stale)
      const [query] = await client.embed([search.query], 'query')
      return { records: await nearestMemories(db, ownerId, query, search.personaId, search.limit) }
    },

    /** Vectors of short texts that the client compares with each other, for example topic labels. */
    async embed(texts: readonly string[]) {
      const embeddings = await requireEmbedder().embed(texts, 'similarity')
      return { records: embeddings.map(embedding => ({ embedding })) }
    },
  }
}

export type MemoryService = ReturnType<typeof createMemoryService>
