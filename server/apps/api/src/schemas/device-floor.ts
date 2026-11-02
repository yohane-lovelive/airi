import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * The device that holds the floor of an account: only this device runs autonomous speech and missions.
 * One row for each account. A device takes the row over when the holder stops its heartbeat.
 */
export const deviceFloor = pgTable('device_floor', {
  ownerId: text('owner_id').primaryKey(),
  /** A random id of the client. It says nothing about the device. */
  deviceId: text('device_id').notNull(),
  /** When this device took the floor. */
  claimedAt: timestamp('claimed_at').notNull(),
  /** The last heartbeat of the holder. */
  heartbeatAt: timestamp('heartbeat_at').notNull(),
})
