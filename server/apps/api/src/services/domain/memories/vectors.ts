import type { Database } from '../../../libs/db'
import type { EmbedderClient } from '../../adapters/embedder'

import { createHash } from 'node:crypto'

import { and, cosineDistance, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'

import { memories, memoryFields, memoryVectors } from '../../../schemas/memories'
import { EMBEDDER_BATCH_LIMIT } from '../../adapters/embedder'

/** The current content of one memory entry. */
export interface MemoryContent {
  description: string
  body: string
  persona?: string
}

/** A document and the revision that its vector must describe. */
export interface MemoryRevision {
  documentId: string
  revision: number
}

/** The text that the embedder reads for an entry: the index line, then the body. */
export function memoryText(content: MemoryContent) {
  return content.description ? `${content.description}\n${content.body}` : content.body
}

export function contentHash(text: string) {
  return createHash('sha256').update(text).digest('hex')
}

/** The current content of the given live entries. An entry without a body is left out. */
export async function currentContents(db: Database, ownerId: string, documentIds: readonly string[]) {
  if (!documentIds.length)
    return new Map<string, MemoryContent>()
  const rows = await db.selectDistinctOn([memoryFields.documentId, memoryFields.key])
    .from(memoryFields)
    .where(and(eq(memoryFields.ownerId, ownerId), inArray(memoryFields.documentId, [...documentIds])))
    .orderBy(memoryFields.documentId, memoryFields.key, desc(memoryFields.revision))

  const contents = new Map<string, MemoryContent>()
  for (const [documentId, fields] of Map.groupBy(rows, row => row.documentId)) {
    // A removed field has a `null` value. The validator lets only strings in.
    const values = new Map(fields.flatMap(field => typeof field.value === 'string' ? [[field.key, field.value] as const] : []))
    const body = values.get('body')
    if (!body)
      continue
    const persona = values.get('persona')
    contents.set(documentId, { description: values.get('description') ?? '', body, ...(persona ? { persona } : {}) })
  }
  return contents
}

/**
 * The live entries whose vector is missing, describes an older revision, or comes from another model. Oldest
 * changes first, at most `limit`.
 */
export async function staleRevisions(db: Database, ownerId: string, model: string, limit: number): Promise<MemoryRevision[]> {
  return db.select({ documentId: memories.documentId, revision: memories.revision })
    .from(memories)
    .leftJoin(memoryVectors, and(eq(memoryVectors.ownerId, memories.ownerId), eq(memoryVectors.documentId, memories.documentId)))
    .where(and(
      eq(memories.ownerId, ownerId),
      isNull(memories.deletedAt),
      or(isNull(memoryVectors.documentId), ne(memoryVectors.revision, memories.revision), ne(memoryVectors.model, model)),
    ))
    .orderBy(memories.updatedAt)
    .limit(limit)
}

/**
 * Brings the vectors of the given entries to their revisions.
 *
 * - An entry whose text and model did not change keeps its vector. Only its revision and persona change.
 * - An entry with a changed text is embedded again, in batches of the embedder.
 * - An entry without content loses its vector.
 */
export async function refreshVectors(db: Database, embedder: EmbedderClient, ownerId: string, revisions: readonly MemoryRevision[]) {
  if (!revisions.length)
    return
  const ids = revisions.map(revision => revision.documentId)
  const contents = await currentContents(db, ownerId, ids)
  const stored = new Map((await db.select().from(memoryVectors).where(and(eq(memoryVectors.ownerId, ownerId), inArray(memoryVectors.documentId, ids))))
    .map(row => [row.documentId, row]))

  const empty = ids.filter(id => !contents.has(id))
  if (empty.length)
    await db.delete(memoryVectors).where(and(eq(memoryVectors.ownerId, ownerId), inArray(memoryVectors.documentId, empty)))

  const rows: (typeof memoryVectors.$inferInsert)[] = []
  const toEmbed: { revision: MemoryRevision, content: MemoryContent, text: string, hash: string }[] = []
  for (const revision of revisions) {
    const content = contents.get(revision.documentId)
    if (!content)
      continue
    const text = memoryText(content)
    const hash = contentHash(text)
    const previous = stored.get(revision.documentId)
    if (previous && previous.contentHash === hash && previous.model === embedder.model)
      rows.push({ ...previous, revision: revision.revision, persona: content.persona ?? null, updatedAt: new Date() })
    else
      toEmbed.push({ revision, content, text, hash })
  }

  for (let start = 0; start < toEmbed.length; start += EMBEDDER_BATCH_LIMIT) {
    const batch = toEmbed.slice(start, start + EMBEDDER_BATCH_LIMIT)
    const embeddings = await embedder.embed(batch.map(item => item.text), 'document')
    rows.push(...batch.map((item, index) => ({
      ownerId,
      documentId: item.revision.documentId,
      revision: item.revision.revision,
      persona: item.content.persona ?? null,
      contentHash: item.hash,
      model: embedder.model,
      embedding: embeddings[index],
      updatedAt: new Date(),
    })))
  }

  if (!rows.length)
    return
  await db.insert(memoryVectors).values(rows).onConflictDoUpdate({
    target: [memoryVectors.ownerId, memoryVectors.documentId],
    set: {
      revision: sql`excluded.revision`,
      persona: sql`excluded.persona`,
      contentHash: sql`excluded.content_hash`,
      model: sql`excluded.model`,
      embedding: sql`excluded.embedding`,
      updatedAt: sql`excluded.updated_at`,
    },
  })
}

/** The live entries of a card and the general entries, nearest to the query vector first. */
export async function nearestMemories(db: Database, ownerId: string, query: number[], personaId: string, limit: number) {
  const distance = cosineDistance(memoryVectors.embedding, query)
  const rows = await db.select({ id: memoryVectors.documentId, distance })
    .from(memoryVectors)
    .innerJoin(memories, and(eq(memories.ownerId, memoryVectors.ownerId), eq(memories.documentId, memoryVectors.documentId)))
    .where(and(
      eq(memoryVectors.ownerId, ownerId),
      isNull(memories.deletedAt),
      or(eq(memoryVectors.persona, personaId), isNull(memoryVectors.persona)),
    ))
    .orderBy(distance)
    .limit(limit)
  return rows.map(row => ({ id: row.id, score: 1 - Number(row.distance) }))
}
