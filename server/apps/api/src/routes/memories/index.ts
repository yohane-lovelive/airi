import type { BaseIssue, BaseSchema } from 'valibot'

import type { MemoryService } from '../../services/domain/memories'
import type { HonoEnv } from '../../types/hono'

import { createBadRequestError } from '@proj-airi/http-error-shared'
import { Hono } from 'hono'
import { array, integer, maxLength, maxValue, minLength, minValue, number, object, optional, pipe, safeParse, string } from 'valibot'

import { authGuard } from '../../middlewares/auth'
import { EMBEDDER_BATCH_LIMIT } from '../../services/adapters/embedder'
import { parseDeleteRevision, parseDocumentId, parsePushRequest, readJsonBody } from '../../services/domain/field-sync'

const SearchRequestSchema = object({
  query: pipe(string(), minLength(1), maxLength(500)),
  personaId: pipe(string(), minLength(1), maxLength(128)),
  limit: optional(pipe(number(), integer(), minValue(1), maxValue(20)), 5),
})

const EmbedRequestSchema = object({
  texts: pipe(array(pipe(string(), minLength(1), maxLength(200))), minLength(1), maxLength(EMBEDDER_BATCH_LIMIT)),
})

function parseBody<TOutput>(schema: BaseSchema<unknown, TOutput, BaseIssue<unknown>>, body: unknown) {
  const result = safeParse(schema, body)
  if (!result.success)
    throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', result.issues)
  return result.output
}

/**
 * The long-term memories of a user: the field store routes of the sync, and the search by meaning.
 *
 * `POST /search` and `POST /embed` answer `503 EMBEDDER_UNAVAILABLE` when the deployment runs no embedder, or when it
 * fails. The client then recalls by character pairs.
 */
export function createMemoryRoutes(memoryService: MemoryService) {
  return new Hono<HonoEnv>()
    .use('*', authGuard)

    .get('/', async (c) => {
      const user = c.get('user')!
      return c.json(await memoryService.list(user.id))
    })

    .post('/search', async (c) => {
      const user = c.get('user')!
      return c.json(await memoryService.search(user.id, parseBody(SearchRequestSchema, await readJsonBody(c.req))))
    })

    .post('/embed', async (c) => {
      const { texts } = parseBody(EmbedRequestSchema, await readJsonBody(c.req))
      return c.json(await memoryService.embed(texts))
    })

    .put('/:id', async (c) => {
      const user = c.get('user')!
      const fields = parsePushRequest(await readJsonBody(c.req))
      return c.json(await memoryService.push(user.id, parseDocumentId(c.req.param('id')), fields))
    })

    .delete('/:id', async (c) => {
      const user = c.get('user')!
      await memoryService.remove(user.id, parseDocumentId(c.req.param('id')), parseDeleteRevision(c.req.query()))
      return c.body(null, 204)
    })
}
