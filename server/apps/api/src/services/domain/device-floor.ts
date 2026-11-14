import type { Database } from '../../libs/db'

import { and, eq, lte, or, sql } from 'drizzle-orm'

import { deviceFloor } from '../../schemas/device-floor'

/** A holder without a heartbeat for this time loses the floor to the next device that asks. */
export const FLOOR_TAKEOVER_MS = 30_000

export interface DeviceFloorOptions {
  /** @default () => new Date() */
  now?: () => Date
}

/**
 * Decides which device of an account holds the floor.
 *
 * Use when:
 * - The renderer leader of a device sends its heartbeat, or gives the floor up when it closes.
 *
 * Expects:
 * - One heartbeat about every 10 seconds from each device that wants the floor.
 *
 * Returns:
 * - `claim`, which one atomic upsert decides, so two instances of the API never give the floor to two devices.
 */
export function createDeviceFloorService(db: Database, options: DeviceFloorOptions = {}) {
  const now = options.now ?? (() => new Date())

  return {
    /** Takes or keeps the floor, and tells which device holds it. */
    async claim(ownerId: string, deviceId: string) {
      const at = now()
      const stale = new Date(at.getTime() - FLOOR_TAKEOVER_MS)
      const [claimed] = await db.insert(deviceFloor)
        .values({ ownerId, deviceId, claimedAt: at, heartbeatAt: at })
        .onConflictDoUpdate({
          target: deviceFloor.ownerId,
          set: {
            deviceId: sql`excluded.device_id`,
            // The holder keeps the time when it took the floor. A new holder starts its own.
            claimedAt: sql`case when ${deviceFloor.deviceId} = excluded.device_id then ${deviceFloor.claimedAt} else excluded.claimed_at end`,
            heartbeatAt: sql`excluded.heartbeat_at`,
          },
          setWhere: or(eq(deviceFloor.deviceId, deviceId), lte(deviceFloor.heartbeatAt, stale)),
        })
        .returning()
      const row = claimed ?? (await db.select().from(deviceFloor).where(eq(deviceFloor.ownerId, ownerId)))[0]
      return { holder: row.deviceId, held: row.deviceId === deviceId, heartbeatAt: row.heartbeatAt.toISOString() }
    },

    /** Gives the floor up. It changes nothing when another device holds it. */
    async release(ownerId: string, deviceId: string) {
      await db.delete(deviceFloor).where(and(eq(deviceFloor.ownerId, ownerId), eq(deviceFloor.deviceId, deviceId)))
    },

    async deleteAllForUser(ownerId: string) {
      await db.delete(deviceFloor).where(eq(deviceFloor.ownerId, ownerId))
    },
  }
}

export type DeviceFloorService = ReturnType<typeof createDeviceFloorService>
