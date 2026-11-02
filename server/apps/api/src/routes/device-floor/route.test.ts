import type { Database } from '../../libs/db'
import type { HonoEnv } from '../../types/hono'

import { ApiError } from '@proj-airi/http-error-shared'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'

import { createDeviceFloorRoutes } from '.'
import { mockDB } from '../../libs/mock-db'
import { createDeviceFloorService, FLOOR_TAKEOVER_MS } from '../../services/domain/device-floor'

import * as schema from '../../schemas'

interface FloorAnswer { holder: string, held: boolean, heartbeatAt: string }

describe('deviceFloorRoutes', () => {
  let db: Database
  let app: Hono<HonoEnv>
  let now: number

  function requestAs(userId: string, path: string, method: string, body?: unknown) {
    return app.fetch(new Request(`http://localhost${path}`, {
      method,
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    }), { user: { id: userId } })
  }

  async function claim(userId: string, deviceId: string) {
    const response = await requestAs(userId, '/', 'PUT', { deviceId })
    expect(response.status).toBe(200)
    return await response.json() as FloorAnswer
  }

  beforeEach(async () => {
    db = await mockDB(schema)
    now = Date.UTC(2026, 10, 2, 12, 0, 0)
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
    app.route('/', createDeviceFloorRoutes(createDeviceFloorService(db, { now: () => new Date(now) })))
  })

  it('rejects a request without a user, and an invalid device id', async () => {
    expect((await app.request('/', { method: 'PUT' })).status).toBe(401)
    expect((await requestAs('owner', '/', 'PUT', { deviceId: 'no spaces' })).status).toBe(400)
    expect((await requestAs('owner', '/', 'PUT', { deviceId: 'a'.repeat(65) })).status).toBe(400)
  })

  it('gives the floor to the first device, keeps it with heartbeats, and lets another device wait', async () => {
    expect(await claim('owner', 'desktop')).toMatchObject({ holder: 'desktop', held: true })

    now += FLOOR_TAKEOVER_MS - 1_000
    expect(await claim('owner', 'phone')).toMatchObject({ holder: 'desktop', held: false })
    expect(await claim('owner', 'desktop')).toMatchObject({ holder: 'desktop', held: true, heartbeatAt: new Date(now).toISOString() })

    now += FLOOR_TAKEOVER_MS - 1_000
    expect(await claim('owner', 'phone')).toMatchObject({ holder: 'desktop', held: false })
  })

  it('moves the floor to the next device after the holder stops for 30 seconds', async () => {
    await claim('owner', 'desktop')

    now += FLOOR_TAKEOVER_MS
    expect(await claim('owner', 'phone')).toMatchObject({ holder: 'phone', held: true })
    expect(await claim('owner', 'desktop')).toMatchObject({ holder: 'phone', held: false })
  })

  it('frees the floor on a release by the holder only', async () => {
    await claim('owner', 'desktop')

    expect((await requestAs('owner', '/phone', 'DELETE')).status).toBe(204)
    expect(await claim('owner', 'phone')).toMatchObject({ holder: 'desktop', held: false })

    expect((await requestAs('owner', '/desktop', 'DELETE')).status).toBe(204)
    expect(await claim('owner', 'phone')).toMatchObject({ holder: 'phone', held: true })
  })

  it('keeps the floor of each account apart, and removes it with the account', async () => {
    await claim('owner', 'desktop')
    expect(await claim('other', 'laptop')).toMatchObject({ holder: 'laptop', held: true })

    await createDeviceFloorService(db).deleteAllForUser('owner')

    expect(await claim('owner', 'phone')).toMatchObject({ holder: 'phone', held: true })
    expect(await claim('other', 'phone')).toMatchObject({ holder: 'laptop', held: false })
  })
})
