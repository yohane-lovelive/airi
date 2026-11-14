import { foreignKey, index, integer, pgTable, primaryKey, text, timestamp, vector } from 'drizzle-orm/pg-core'

import { jsonValue } from '../libs/json-value'

/** The dimensions of a memory vector. The embedder cuts EmbeddingGemma 2 to them. */
export const MEMORY_VECTOR_DIMENSIONS = 256

/**
 * The long-term memories of the character, one document for each entry.
 *
 * The tables follow the contract of `createFieldSyncStore`. The client mints
 * the document id, a UUIDv7.
 */
export const memories = pgTable(
  'memories',
  {
    ownerId: text('owner_id').notNull(),
    documentId: text('document_id').notNull(),
    revision: integer('revision').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  table => [
    primaryKey({ name: 'memories_pk', columns: [table.ownerId, table.documentId] }),
  ],
)

/**
 * One row for each change to a field of an entry: `description`, `body`, or
 * `persona`. A `null` value means that the revision removed the field.
 */
export const memoryFields = pgTable(
  'memory_fields',
  {
    ownerId: text('owner_id').notNull(),
    documentId: text('document_id').notNull(),
    key: text('key').notNull(),
    value: jsonValue('value'),
    revision: integer('revision').notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  table => [
    primaryKey({ name: 'memory_fields_pk', columns: [table.ownerId, table.documentId, table.key, table.revision] }),
    foreignKey({
      name: 'memory_fields_document_fk',
      columns: [table.ownerId, table.documentId],
      foreignColumns: [memories.ownerId, memories.documentId],
    }).onDelete('cascade'),
  ],
)

/**
 * The vector of each live entry, for the search by meaning.
 *
 * `revision` is the document revision that the row describes. A row with an
 * older revision is stale, and the next search embeds the entry again when its
 * text changed. `contentHash` tells whether the text changed.
 */
export const memoryVectors = pgTable(
  'memory_vectors',
  {
    ownerId: text('owner_id').notNull(),
    documentId: text('document_id').notNull(),
    revision: integer('revision').notNull(),
    /** The character card of the entry. `null` is a general entry, which every card reads. */
    persona: text('persona'),
    contentHash: text('content_hash').notNull(),
    model: text('model').notNull(),
    embedding: vector('embedding', { dimensions: MEMORY_VECTOR_DIMENSIONS }).notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  table => [
    primaryKey({ name: 'memory_vectors_pk', columns: [table.ownerId, table.documentId] }),
    index('memory_vectors_owner_persona_idx').on(table.ownerId, table.persona),
    foreignKey({
      name: 'memory_vectors_document_fk',
      columns: [table.ownerId, table.documentId],
      foreignColumns: [memories.ownerId, memories.documentId],
    }).onDelete('cascade'),
  ],
)
