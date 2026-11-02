import type { Database } from '../../libs/db'
import type { EmbedderClient, EmbeddingTask } from '../../services/adapters/embedder'
import type { HonoEnv } from '../../types/hono'

import { ApiError } from '@proj-airi/http-error-shared'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryRoutes } from '.'
import { mockDB } from '../../libs/mock-db'
import { createEmbedderUnavailableError } from '../../services/adapters/embedder'
import { createMemoryService } from '../../services/domain/memories'

import * as schema from '../../schemas'

/** Words of one meaning share a dimension, so a query finds an entry without a shared word. */
const MEANINGS = [['ラーメン', '食べ物'], ['旅行', '出かける'], ['猫', 'ペット']]

function vectorOf(text: string) {
  const vector = Array.from<number>({ length: 256 }).fill(0)
  const meaning = MEANINGS.findIndex(words => words.some(word => text.includes(word)))
  vector[meaning === -1 ? 255 : meaning] = 1
  return vector
}

function fakeEmbedder() {
  const embed = vi.fn(async (texts: readonly string[], _task: EmbeddingTask) => texts.map(vectorOf))
  return { model: 'fake/256', embed } satisfies EmbedderClient
}

interface ListedDocuments { documents: { fields: { key: string }[] }[] }
interface FoundMemories { records: { id: string, score: number }[] }

/** The routes answer JSON that the test reads with a known shape. */
async function jsonOf<T>(response: Response) {
  return await response.json() as T
}

describe('memoryRoutes', () => {
  let db: Database
  let embedder: ReturnType<typeof fakeEmbedder>

  function appWith(client: EmbedderClient | undefined) {
    const app = new Hono<HonoEnv>()
    app.onError((error, c) => error instanceof ApiError
      ? c.json({ error: error.errorCode, message: error.message, details: error.details }, error.statusCode)
      : c.json({ error: 'Internal Server Error', message: error.message }, 500))
    app.use('*', async (c, next) => {
      const user = (c.env as { user?: HonoEnv['Variables']['user'] } | undefined)?.user
      if (user)
        c.set('user', user)
      await next()
    })
    app.route('/', createMemoryRoutes(createMemoryService(db, client)))
    return app
  }

  function requestAs(app: Hono<HonoEnv>, userId: string, path: string, method: string, body?: unknown) {
    return app.fetch(new Request(`http://localhost${path}`, {
      method,
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    }), { user: { id: userId } })
  }

  function write(app: Hono<HonoEnv>, userId: string, id: string, entry: { description?: string, body: string, persona?: string }, baseRevision = 0) {
    const fields = Object.entries(entry).map(([key, value]) => ({ key, baseRevision, value }))
    return requestAs(app, userId, `/${id}`, 'PUT', { fields })
  }

  function search(app: Hono<HonoEnv>, userId: string, query: string, personaId = 'airi') {
    return requestAs(app, userId, '/search', 'POST', { query, personaId })
  }

  beforeEach(async () => {
    db = await mockDB(schema)
    embedder = fakeEmbedder()
  })

  it('rejects a request without a user', async () => {
    expect((await appWith(embedder).request('/')).status).toBe(401)
  })

  it('stores, lists, and deletes the entries of their owner only', async () => {
    const app = appWith(embedder)
    expect((await write(app, 'owner', 'm1', { description: '好物', body: '好物はラーメン', persona: 'airi' })).status).toBe(200)

    const listed = await jsonOf<ListedDocuments>(await requestAs(app, 'owner', '/', 'GET'))
    expect(listed.documents).toHaveLength(1)
    expect(listed.documents[0].fields.map(field => field.key).sort()).toEqual(['body', 'description', 'persona'])
    expect((await jsonOf<ListedDocuments>(await requestAs(app, 'other', '/', 'GET'))).documents).toEqual([])

    expect((await requestAs(app, 'owner', '/m1?revision=1', 'DELETE')).status).toBe(204)
    expect(await (await search(app, 'owner', '好きな食べ物は？')).json()).toEqual({ records: [] })
  })

  it('refuses unknown fields, an empty body, and values over the limits', async () => {
    const app = appWith(embedder)

    expect((await write(app, 'owner', 'm1', { body: 'x', unknown: 'y' } as never)).status).toBe(400)
    expect((await write(app, 'owner', 'm2', { body: '' })).status).toBe(400)
    expect((await write(app, 'owner', 'm3', { description: 'a'.repeat(151), body: 'x' })).status).toBe(400)
    expect((await write(app, 'owner', 'm4', { body: 'a'.repeat(2_001) })).status).toBe(400)
  })

  it('finds entries by meaning, for the card and the general entries, best first', async () => {
    const app = appWith(embedder)
    await write(app, 'owner', 'ramen', { body: '好物はラーメン', persona: 'airi' })
    await write(app, 'owner', 'trip', { body: '来週は大阪へ旅行', persona: 'airi' })
    await write(app, 'owner', 'cat', { body: '猫を飼っている' })
    await write(app, 'owner', 'other-card', { body: 'ラーメンが嫌い', persona: 'someone' })
    await write(app, 'stranger', 'theirs', { body: 'ラーメン屋で働く' })

    const food = await jsonOf<FoundMemories>(await search(app, 'owner', '好きな食べ物は？'))
    expect(food.records[0]).toEqual({ id: 'ramen', score: expect.closeTo(1, 5) })
    expect(food.records.map(record => record.id)).not.toContain('other-card')
    expect(food.records.map(record => record.id)).not.toContain('theirs')

    const pet = await jsonOf<FoundMemories>(await search(app, 'owner', 'ペットはいる？'))
    expect(pet.records[0].id).toBe('cat')
  })

  it('embeds an entry again only when its text changes', async () => {
    const app = appWith(embedder)
    await write(app, 'owner', 'm1', { body: '好物はラーメン', persona: 'airi' })
    expect(embedder.embed).toHaveBeenCalledTimes(1)

    // A new card keeps the text, so no embedding runs, and the search follows the new card.
    await requestAs(app, 'owner', '/m1', 'PUT', { fields: [{ key: 'persona', baseRevision: 1, value: 'other' }] })
    expect(embedder.embed).toHaveBeenCalledTimes(1)
    expect((await jsonOf<FoundMemories>(await search(app, 'owner', '食べ物', 'airi'))).records).toEqual([])

    await requestAs(app, 'owner', '/m1', 'PUT', { fields: [{ key: 'body', baseRevision: 1, value: '猫を飼っている' }] })
    expect(embedder.embed).toHaveBeenCalledTimes(3)
    expect((await jsonOf<FoundMemories>(await search(app, 'owner', 'ペット', 'other'))).records[0].id).toBe('m1')
  })

  it('keeps a write when the embedder fails, and embeds the entry at the next search', async () => {
    embedder.embed.mockRejectedValueOnce(createEmbedderUnavailableError())
    const app = appWith(embedder)

    expect((await write(app, 'owner', 'm1', { body: '好物はラーメン', persona: 'airi' })).status).toBe(200)
    const found = await jsonOf<FoundMemories>(await search(app, 'owner', '好きな食べ物は？'))

    expect(found.records[0].id).toBe('m1')
  })

  it('answers 503 for a search and an embed without an embedder, and still syncs', async () => {
    const app = appWith(undefined)

    expect((await write(app, 'owner', 'm1', { body: '好物はラーメン' })).status).toBe(200)
    const searched = await search(app, 'owner', '食べ物')
    expect(searched.status).toBe(503)
    expect((await jsonOf<{ error: string }>(searched)).error).toBe('EMBEDDER_UNAVAILABLE')
    expect((await requestAs(app, 'owner', '/embed', 'POST', { texts: ['ラーメン'] })).status).toBe(503)
  })

  it('embeds short texts for similarity, and refuses an invalid search', async () => {
    const app = appWith(embedder)

    const embedded = await jsonOf<{ records: unknown[] }>(await requestAs(app, 'owner', '/embed', 'POST', { texts: ['ラーメン', '旅行'] }))
    expect(embedded.records).toHaveLength(2)
    expect(embedder.embed).toHaveBeenCalledWith(['ラーメン', '旅行'], 'similarity')
    expect((await requestAs(app, 'owner', '/search', 'POST', { query: '', personaId: 'airi' })).status).toBe(400)
    expect((await requestAs(app, 'owner', '/search', 'POST', { query: 'x', personaId: 'airi', limit: 50 })).status).toBe(400)
  })

  it('removes the memories and vectors of a deleted account', async () => {
    const service = createMemoryService(db, embedder)
    await service.push('owner', 'm1', [{ key: 'body', baseRevision: 0, value: '好物はラーメン' }])

    await service.deleteAllForUser('owner')

    expect((await service.list('owner')).documents.every(document => document.fields.length === 0)).toBe(true)
    expect((await service.search('owner', { query: '食べ物', personaId: 'airi', limit: 5 })).records).toEqual([])
  })
})
