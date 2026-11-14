import type { SettingsSyncService } from '../../services/domain/settings-sync'
import type { HonoEnv } from '../../types/hono'

import { Hono } from 'hono'

import { authGuard } from '../../middlewares/auth'
import { parseDeleteRevision, parseDocumentId, parsePushRequest, readJsonBody } from '../../services/domain/field-sync'

export function createSettingsSyncRoutes(settingsSyncService: SettingsSyncService) {
  return new Hono<HonoEnv>()
    .use('*', authGuard)

    .get('/', async (c) => {
      const user = c.get('user')!
      return c.json(await settingsSyncService.list(user.id))
    })

    .put('/:id', async (c) => {
      const user = c.get('user')!
      const fields = parsePushRequest(await readJsonBody(c.req))
      return c.json(await settingsSyncService.push(user.id, parseDocumentId(c.req.param('id')), fields))
    })

    .delete('/:id', async (c) => {
      const user = c.get('user')!
      await settingsSyncService.remove(user.id, parseDocumentId(c.req.param('id')), parseDeleteRevision(c.req.query()))
      return c.body(null, 204)
    })
}
