import { createServiceUnavailableError } from '@proj-airi/http-error-shared'
import { array, number, object, safeParse } from 'valibot'

/** The kinds of text that the embedder takes. Each kind gets its own prefix there. */
export type EmbeddingTask = 'query' | 'document' | 'similarity'

/** The embedder service splits nothing, so a caller sends at most this many texts in one request. */
export const EMBEDDER_BATCH_LIMIT = 32

export interface EmbedderClient {
  /** The name of the model that made the vectors. A stored vector of another model is stale. */
  readonly model: string
  embed: (texts: readonly string[], task: EmbeddingTask) => Promise<number[][]>
}

export interface EmbedderClientOptions {
  url: string
  /** @default 10_000. A search waits for it, so it stays short. */
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

const EmbedResponseSchema = object({
  records: array(object({ embedding: array(number()) })),
})

/** The error of every failure, so a client of the API can recall by character pairs instead. */
export function createEmbedderUnavailableError() {
  return createServiceUnavailableError('The memory embedder is not available', 'EMBEDDER_UNAVAILABLE')
}

/**
 * Calls the `embedder` service of the stack over HTTP.
 *
 * Use when:
 * - The memory service embeds entries on a write, or a query on a search.
 *
 * Returns:
 * - One vector for each text, in order. Every failure, a timeout too, throws `503 EMBEDDER_UNAVAILABLE`.
 */
export function createEmbedderClient(options: EmbedderClientOptions): EmbedderClient {
  const fetch = options.fetch ?? globalThis.fetch
  const endpoint = new URL('/embed', options.url)

  return {
    model: 'embeddinggemma-2/256',
    async embed(texts, task) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts, task }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      }).catch(() => undefined)
      if (!response?.ok)
        throw createEmbedderUnavailableError()
      const parsed = safeParse(EmbedResponseSchema, await response.json().catch(() => undefined))
      if (!parsed.success || parsed.output.records.length !== texts.length)
        throw createEmbedderUnavailableError()
      return parsed.output.records.map(record => record.embedding)
    },
  }
}
