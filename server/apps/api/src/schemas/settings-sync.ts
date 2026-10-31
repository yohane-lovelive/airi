import { foreignKey, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

import { jsonValue } from '../libs/json-value'

/**
 * The settings groups that a user synchronizes between devices.
 *
 * The tables follow the contract of `createFieldSyncStore`. The client owns
 * the group ids, for example `speech` or `live2d`.
 */
export const syncedSettings = pgTable(
  'synced_settings',
  {
    ownerId: text('owner_id').notNull(),
    documentId: text('document_id').notNull(),
    revision: integer('revision').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  table => [
    primaryKey({ name: 'synced_settings_pk', columns: [table.ownerId, table.documentId] }),
  ],
)

/**
 * One row for each change to a setting. The key is the `localStorage` key of
 * the client, and the value is the raw stored string. A `null` value means
 * that the revision removed the setting.
 */
export const syncedSettingFields = pgTable(
  'synced_settings_fields',
  {
    ownerId: text('owner_id').notNull(),
    documentId: text('document_id').notNull(),
    key: text('key').notNull(),
    value: jsonValue('value'),
    revision: integer('revision').notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  table => [
    primaryKey({ name: 'synced_settings_fields_pk', columns: [table.ownerId, table.documentId, table.key, table.revision] }),
    foreignKey({
      name: 'synced_settings_fields_document_fk',
      columns: [table.ownerId, table.documentId],
      foreignColumns: [syncedSettings.ownerId, syncedSettings.documentId],
    }).onDelete('cascade'),
  ],
)
