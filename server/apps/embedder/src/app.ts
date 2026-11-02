import type { Logger } from '@guiiai/logg'

import type { TextEmbedder } from './model'

import { createBadRequestError, createErrorHandler } from '@proj-airi/http-error-shared'
import { Hono } from 'hono'
import { array, maxLength, minLength, object, picklist, pipe, safeParse, string } from 'valibot'

import { EMBEDDING_TASKS } from './prefix'

/** A batch holds 32 texts at most, so one batch stays short on a CPU. */
export const MAX_BATCH_TEXTS = 32
/** About 2,000 tokens. A memory entry has 2,150 characters at most. */
export const MAX_TEXT_LENGTH = 8_000

const EmbedRequestSchema = object({
  texts: pipe(array(pipe(string(), minLength(1), maxLength(MAX_TEXT_LENGTH))), minLength(1), maxLength(MAX_BATCH_TEXTS)),
  task: picklist(EMBEDDING_TASKS),
})

/**
 * The HTTP app of the embedder. It listens only on the internal network, so it has no authentication.
 *
 * - `GET /healthz` answers while the process runs.
 * - `POST /embed` takes `{ texts, task }` and returns `{ records: [{ embedding }] }`, one record for each text in order.
 */
export function createEmbedderApp(embedder: TextEmbedder, logger: Logger) {
  return new Hono()
    .onError(createErrorHandler(logger))
    .get('/healthz', c => c.json({ ok: true }))
    .post('/embed', async (c) => {
      const parsed = safeParse(EmbedRequestSchema, await c.req.json().catch(() => undefined))
      if (!parsed.success)
        throw createBadRequestError('Invalid embed request', 'INVALID_REQUEST', parsed.issues.map(issue => issue.message))
      const embeddings = await embedder.embed(parsed.output.texts, parsed.output.task)
      return c.json({ records: embeddings.map(embedding => ({ embedding })) })
    })
}
