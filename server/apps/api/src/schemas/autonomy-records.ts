import { foreignKey, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

import { jsonValue } from '../libs/json-value'

/**
 * The reminders and intentions of the character, one document for each record.
 *
 * The tables follow the contract of `createFieldSyncStore`. The client mints
 * the document id, which is the id of the reminder or the intention.
 */
export const autonomyRecords = pgTable(
  'autonomy_records',
  {
    ownerId: text('owner_id').notNull(),
    documentId: text('document_id').notNull(),
    revision: integer('revision').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  table => [
    primaryKey({ name: 'autonomy_records_pk', columns: [table.ownerId, table.documentId] }),
  ],
)

/**
 * One row for each change to a field: `kind` and `record`. The server keeps
 * `record` as JSON and does not read it. A `null` value means that the
 * revision removed the field.
 */
export const autonomyRecordFields = pgTable(
  'autonomy_record_fields',
  {
    ownerId: text('owner_id').notNull(),
    documentId: text('document_id').notNull(),
    key: text('key').notNull(),
    value: jsonValue('value'),
    revision: integer('revision').notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  table => [
    primaryKey({ name: 'autonomy_record_fields_pk', columns: [table.ownerId, table.documentId, table.key, table.revision] }),
    foreignKey({
      name: 'autonomy_record_fields_document_fk',
      columns: [table.ownerId, table.documentId],
      foreignColumns: [autonomyRecords.ownerId, autonomyRecords.documentId],
    }).onDelete('cascade'),
  ],
)
