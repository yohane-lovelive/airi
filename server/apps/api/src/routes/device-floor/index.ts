import type { DeviceFloorService } from '../../services/domain/device-floor'
import type { HonoEnv } from '../../types/hono'

import { createBadRequestError } from '@proj-airi/http-error-shared'
import { Hono } from 'hono'
import { maxLength, minLength, object, pipe, regex, safeParse, string } from 'valibot'

import { authGuard } from '../../middlewares/auth'
import { readJsonBody } from '../../services/domain/field-sync'

/** A random id of the client, for example a UUID. */
const DeviceIdSchema = pipe(string(), minLength(1), maxLength(64), regex(/^[\w-]+$/))
const ClaimRequestSchema = object({ deviceId: DeviceIdSchema })

function parseDeviceId(input: unknown) {
  const result = safeParse(DeviceIdSchema, input)
  if (!result.success)
    throw createBadRequestError('Invalid device id', 'INVALID_REQUEST', result.issues)
  return result.output
}

/**
 * The floor of an account: which device runs autonomous speech and missions.
 * `PUT /` claims or keeps it with a heartbeat. `DELETE /:deviceId` gives it up.
 */
export function createDeviceFloorRoutes(deviceFloorService: DeviceFloorService) {
  return new Hono<HonoEnv>()
    .use('*', authGuard)

    .put('/', async (c) => {
      const user = c.get('user')!
      const parsed = safeParse(ClaimRequestSchema, await readJsonBody(c.req))
      if (!parsed.success)
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', parsed.issues)
      return c.json(await deviceFloorService.claim(user.id, parsed.output.deviceId))
    })

    .delete('/:deviceId', async (c) => {
      const user = c.get('user')!
      await deviceFloorService.release(user.id, parseDeviceId(c.req.param('deviceId')))
      return c.body(null, 204)
    })
}
