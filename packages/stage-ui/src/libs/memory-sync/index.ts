import type { MemoryEntry } from '../../types/memory'
import type { DocumentFields, LocalDocumentChanges } from '../document-sync'

import { maxLength, minLength, optional, pipe, safeParse, strictObject, string } from 'valibot'

/**
 * The fields of one memory on the server. They follow the limits of the memory tools, and the server checks the same
 * limits. Values come from other devices, so this is a trust boundary.
 */
const MemoryFieldsSchema = strictObject({
  description: optional(pipe(string(), maxLength(150)), ''),
  body: pipe(string(), minLength(1), maxLength(2_000)),
  persona: optional(pipe(string(), minLength(1), maxLength(128))),
})

/**
 * Splits an entry into the fields that devices sync separately. A general entry has no `persona` field.
 * `updatedAt` stays on the device, so an edit on two devices does not conflict on the time alone.
 */
export function memoryToFields(entry: MemoryEntry): DocumentFields {
  return {
    description: entry.description,
    body: entry.body,
    ...(entry.persona ? { persona: entry.persona } : {}),
  }
}

/** Joins the fields from another device into an entry, or undefined when they are invalid. */
export function memoryFromFields(id: string, fields: DocumentFields, updatedAt: number): MemoryEntry | undefined {
  const parsed = safeParse(MemoryFieldsSchema, fields)
  if (!parsed.success)
    return undefined
  const { description, body, persona } = parsed.output
  return { id, description, body, ...(persona ? { persona } : {}), updatedAt }
}

/**
 * The creation time in a UUIDv7: its first 48 bits are milliseconds since 1970. An entry that reaches this device for
 * the first time takes it, so a new device lists the entries in the order that they were made.
 */
export function createdAtOfId(id: string, fallback: number) {
  const hex = id.replaceAll('-', '').slice(0, 12)
  const time = /^[0-9a-f]{12}$/i.test(hex) && id.charAt(14) === '7' ? Number.parseInt(hex, 16) : Number.NaN
  return Number.isFinite(time) && time <= fallback ? time : fallback
}

/** The result of one round of the sync on the local entries. */
export interface AppliedMemoryChanges {
  /** The live entries after the round, oldest change first. */
  entries: MemoryEntry[]
  /** The entries to save, the copies of lost conflicts too. */
  saved: MemoryEntry[]
  /** The ids that other devices removed. */
  removed: string[]
  /** The ids of upserts with invalid fields. Their local entries stay as they are. */
  rejected: string[]
}

/**
 * Applies the changes of one sync round to the local entries.
 *
 * - An upsert replaces the entry. An entry that is new on this device takes the time of its id.
 * - A removal drops the entry.
 * - A local entry that lost a conflict becomes a new entry with `newId`, so no fact is lost.
 */
export function applyMemoryChanges(current: readonly MemoryEntry[], changes: LocalDocumentChanges, now: number, newId: () => string): AppliedMemoryChanges {
  const byId = new Map(current.map(entry => [entry.id, entry]))
  const saved: MemoryEntry[] = []
  const rejected: string[] = []

  for (const copy of changes.conflictCopies) {
    const entry = memoryFromFields(newId(), copy.fields, now)
    if (entry)
      saved.push(entry)
  }
  for (const [id, fields] of Object.entries(changes.upserts)) {
    const known = byId.get(id)
    const entry = memoryFromFields(id, fields, known ? now : createdAtOfId(id, now))
    if (!entry) {
      rejected.push(id)
      continue
    }
    saved.push(entry)
  }
  for (const entry of saved)
    byId.set(entry.id, entry)
  const removed = changes.removals.filter(id => byId.delete(id))

  return { entries: [...byId.values()].sort((left, right) => left.updatedAt - right.updatedAt), saved, removed, rejected }
}
