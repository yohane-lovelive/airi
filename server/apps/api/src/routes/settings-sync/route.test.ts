import type { Database } from '../../libs/db'
import type { HonoEnv } from '../../types/hono'

import { ApiError } from '@proj-airi/http-error-shared'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'

import { createSettingsSyncRoutes } from '.'
import { mockDB } from '../../libs/mock-db'
import { createSettingsSyncService } from '../../services/domain/settings-sync'

import * as schema from '../../schemas'

describe('settingsSyncRoutes', () => {
  let db: Database
  let app: Hono<HonoEnv>

  function requestAs(userId: string, path: string, init?: RequestInit) {
    return app.fetch(new Request(`http://localhost${path}`, init), { user: { id: userId } })
  }

  function pushAs(userId: string, path: string, fields: unknown) {
    return requestAs(userId, path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    })
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
    app.route('/', createSettingsSyncRoutes(createSettingsSyncService(db)))
  })

  it('rejects a request without a user', async () => {
    const response = await app.request('/')

    expect(response.status).toBe(401)
  })

  it('stores, lists, and deletes a settings group of its owner only', async () => {
    const pushed = await pushAs('owner', '/speech', [{ key: 'settings/speech/voice', baseRevision: 0, value: 'alloy' }])
    const listed = await requestAs('owner', '/')
    const other = await requestAs('other', '/')

    expect(pushed.status).toBe(200)
    expect(await listed.json()).toEqual({
      documents: [{ id: 'speech', revision: 1, deletedAt: null, fields: [{ key: 'settings/speech/voice', revision: 1, value: 'alloy' }] }],
    })
    expect(await other.json()).toEqual({ documents: [] })

    const deleted = await requestAs('owner', '/speech?revision=1', { method: 'DELETE' })

    expect(deleted.status).toBe(204)
  })

  it('removes a setting', async () => {
    await pushAs('owner', '/general', [{ key: 'settings/language', baseRevision: 0, value: 'ja' }])

    const removed = await pushAs('owner', '/general', [{ key: 'settings/language', baseRevision: 1, removed: true }])
    const listed = await requestAs('owner', '/')

    expect(removed.status).toBe(200)
    expect(await listed.json()).toEqual({ documents: [{ id: 'general', revision: 2, deletedAt: null, fields: [] }] })
  })

  it('rejects a key outside the allowed characters and a value that is not a string', async () => {
    const badKey = await pushAs('owner', '/general', [{ key: 'settings/language?x', baseRevision: 0, value: 'ja' }])
    const notString = await pushAs('owner', '/general', [{ key: 'settings/disable-transitions', baseRevision: 0, value: true }])

    expect(badKey.status).toBe(400)
    expect(notString.status).toBe(400)
    expect(await notString.json()).toMatchObject({ error: 'INVALID_REQUEST', details: ['settings/disable-transitions'] })
  })

  it('rejects a value larger than 64 KiB with 413', async () => {
    const response = await pushAs('owner', '/general', [{ key: 'settings/language', baseRevision: 0, value: 'x'.repeat(64 * 1024) }])

    expect(response.status).toBe(413)
  })
})
