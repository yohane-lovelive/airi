import type { AutonomyRecordService } from '../../services/domain/autonomy-records'
import type { HonoEnv } from '../../types/hono'

import { Hono } from 'hono'

import { authGuard } from '../../middlewares/auth'
import { parseDeleteRevision, parseDocumentId, parsePushRequest, readJsonBody } from '../../services/domain/field-sync'

/** The reminders and intentions of a user, synced between devices through the field store. */
export function createAutonomyRecordRoutes(autonomyRecordService: AutonomyRecordService) {
  return new Hono<HonoEnv>()
    .use('*', authGuard)

    .get('/', async (c) => {
      const user = c.get('user')!
      return c.json(await autonomyRecordService.list(user.id))
    })

    .put('/:id', async (c) => {
      const user = c.get('user')!
      const fields = parsePushRequest(await readJsonBody(c.req))
      return c.json(await autonomyRecordService.push(user.id, parseDocumentId(c.req.param('id')), fields))
    })

    .delete('/:id', async (c) => {
      const user = c.get('user')!
      await autonomyRecordService.remove(user.id, parseDocumentId(c.req.param('id')), parseDeleteRevision(c.req.query()))
      return c.body(null, 204)
    })
}
