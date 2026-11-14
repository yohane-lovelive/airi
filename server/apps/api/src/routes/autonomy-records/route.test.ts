import type { Database } from '../../libs/db'
import type { HonoEnv } from '../../types/hono'

import { ApiError } from '@proj-airi/http-error-shared'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'

import { createAutonomyRecordRoutes } from '.'
import { mockDB } from '../../libs/mock-db'
import { createAutonomyRecordService } from '../../services/domain/autonomy-records'

import * as schema from '../../schemas'

describe('autonomyRecordRoutes', () => {
  let db: Database
  let app: Hono<HonoEnv>

  function requestAs(userId: string, path: string, init?: RequestInit) {
    return app.fetch(new Request(`http://localhost${path}`, init), { user: { id: userId } })
  }

  function pushAs(userId: string, id: string, fields: unknown) {
    return requestAs(userId, `/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) })
  }

  beforeEach(async () => {
    db = await mockDB(schema)
    app = new Hono<HonoEnv>()
    app.onError((error, c) => error instanceof ApiError
      ? c.json({ error: error.errorCode, message: error.message, details: error.details }, error.statusCode)
      : c.json({ error: 'Internal Server Error', message: error.message }, 500))
    app.use('*', async (c, next) => {
      const user = (c.env as { user?: HonoEnv['Variables']['user'] } | undefined)?.user
      if (user)
        c.set('user', user)
      await next()
    })
    app.route('/', createAutonomyRecordRoutes(createAutonomyRecordService(db)))
  })

  it('rejects a request without a user', async () => {
    expect((await app.request('/')).status).toBe(401)
  })

  it('stores, lists, and deletes the records of their owner only', async () => {
    const reminder = { id: 'r1', template: 'reminder', values: { text: '薬を飲む' } }
    const pushed = await pushAs('owner', 'r1', [{ key: 'kind', baseRevision: 0, value: 'reminder' }, { key: 'record', baseRevision: 0, value: reminder }])

    expect(pushed.status).toBe(200)
    const listed = await (await requestAs('owner', '/')).json() as { documents: { id: string, fields: { key: string, value: unknown }[] }[] }
    expect(listed.documents.map(document => document.id)).toEqual(['r1'])
    expect(listed.documents[0].fields.find(field => field.key === 'record')?.value).toEqual(reminder)
    expect(await (await requestAs('other', '/')).json()).toEqual({ documents: [] })

    expect((await requestAs('owner', '/r1?revision=1', { method: 'DELETE' })).status).toBe(204)
  })

  it('refuses an unknown kind, an unknown key, a record that is not an object, and a record over the limit', async () => {
    expect((await pushAs('owner', 'a', [{ key: 'kind', baseRevision: 0, value: 'watch' }])).status).toBe(400)
    expect((await pushAs('owner', 'b', [{ key: 'other', baseRevision: 0, value: 'x' }])).status).toBe(400)
    expect((await pushAs('owner', 'c', [{ key: 'record', baseRevision: 0, value: ['x'] }])).status).toBe(400)
    expect((await pushAs('owner', 'd', [{ key: 'record', baseRevision: 0, value: { text: 'a'.repeat(17_000) } }])).status).toBe(413)
  })

  it('stores the owner profile as its own kind', async () => {
    const pushed = await pushAs('owner', 'owner-profile', [{ key: 'kind', baseRevision: 0, value: 'profile' }, { key: 'record', baseRevision: 0, value: { text: 'ラーメンが好き', updatedAt: 1 } }])

    expect(pushed.status).toBe(200)
  })

  it('removes the records of a deleted account', async () => {
    const service = createAutonomyRecordService(db)
    await service.push('owner', 'i1', [{ key: 'kind', baseRevision: 0, value: 'intention' }, { key: 'record', baseRevision: 0, value: { id: 'i1', text: 'ask about the trip' } }])

    await service.deleteAllForUser('owner')

    expect((await service.list('owner')).documents.every(document => document.fields.length === 0)).toBe(true)
  })
})
