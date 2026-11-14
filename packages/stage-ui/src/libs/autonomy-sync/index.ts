import type { Intention, ReminderMission } from '@proj-airi/core-agent'

import type { DocumentFields, LocalDocumentChanges } from '../document-sync'

import { array, integer, literal, maxLength, minLength, minValue, number, object, optional, picklist, pipe, safeParse, string, union } from 'valibot'

/**
 * A reminder from another device. Values come from other devices, so this is a trust boundary. The server keeps the
 * record as JSON and does not read it.
 */
const ReminderSchema = object({
  id: pipe(string(), minLength(1), maxLength(64)),
  sessionId: string(),
  template: literal('reminder'),
  status: picklist(['scheduled', 'running', 'done', 'stopped', 'missed']),
  nextRunAt: optional(number()),
  lastRunAt: optional(number()),
  endReason: optional(picklist(['time', 'owner', 'away', 'quiet', 'target-closed', 'condition'])),
  createdAt: number(),
  updatedAt: number(),
  values: object({
    text: pipe(string(), minLength(1), maxLength(2_000)),
    at: string(),
    repeat: union([
      object({ kind: literal('once') }),
      object({ kind: literal('daily') }),
      object({ kind: literal('weekdays') }),
      object({ kind: literal('weekly'), days: array(pipe(number(), integer(), minValue(0))) }),
      object({ kind: literal('interval'), minutes: pipe(number(), minValue(1)) }),
    ]),
  }),
})

const ProfileSchema = object({
  text: pipe(string(), minLength(1), maxLength(4_000)),
  updatedAt: number(),
})

const IntentionSchema = object({
  id: pipe(string(), minLength(1), maxLength(64)),
  text: pipe(string(), minLength(1), maxLength(2_000)),
  createdAt: number(),
  expiresAt: number(),
})

/** The kinds of synced records. Small talk, commentary, and watches belong to the screen of one device. */
export type AutonomyRecordKind = 'reminder' | 'intention' | 'profile'

/** The id of the one document of the owner profile. */
export const PROFILE_DOCUMENT_ID = 'owner-profile'

/** A reminder or an intention as the fields of one document. JSON drops reactive proxies and `undefined`. */
export function reminderToFields(reminder: ReminderMission): DocumentFields {
  return { kind: 'reminder', record: JSON.parse(JSON.stringify(reminder)) }
}

export function intentionToFields(intention: Intention): DocumentFields {
  return { kind: 'intention', record: JSON.parse(JSON.stringify(intention)) }
}

export function profileToFields(profile: { text: string, updatedAt: number }): DocumentFields {
  return { kind: 'profile', record: { text: profile.text, updatedAt: profile.updatedAt } }
}

/** The changes of one sync round, for each kind of record. */
export interface AutonomyChanges {
  reminders: { saved: ReminderMission[], removed: string[] }
  intentions: { saved: Intention[], removed: string[] }
  /** The owner profile of another device, `null` when another device cleared it, or undefined without a change. */
  profile?: { text: string, updatedAt: number } | null
  /** The ids of upserts with invalid fields. Their local records stay as they are. */
  rejected: string[]
}

/**
 * Splits the changes of one sync round by kind, and checks each record.
 *
 * - An upsert whose record does not fit its kind is rejected, and its id does not match its record.
 * - A removal goes to the kind of the local record with that id.
 * - A local record that lost a conflict is dropped. A copy of a reminder would remind the owner twice, and only the
 *   device that holds the floor changes a reminder while it runs.
 */
export function splitAutonomyChanges(changes: LocalDocumentChanges, local: { reminderIds: ReadonlySet<string>, intentionIds: ReadonlySet<string> }): AutonomyChanges {
  const result: AutonomyChanges = { reminders: { saved: [], removed: [] }, intentions: { saved: [], removed: [] }, rejected: [] }
  for (const [id, fields] of Object.entries(changes.upserts)) {
    if (fields.kind === 'reminder') {
      const parsed = safeParse(ReminderSchema, fields.record)
      if (parsed.success && parsed.output.id === id) {
        result.reminders.saved.push(parsed.output)
        continue
      }
    }
    else if (fields.kind === 'intention') {
      const parsed = safeParse(IntentionSchema, fields.record)
      if (parsed.success && parsed.output.id === id) {
        result.intentions.saved.push(parsed.output)
        continue
      }
    }
    else if (fields.kind === 'profile' && id === PROFILE_DOCUMENT_ID) {
      const parsed = safeParse(ProfileSchema, fields.record)
      if (parsed.success) {
        result.profile = parsed.output
        continue
      }
    }
    result.rejected.push(id)
  }
  for (const id of changes.removals) {
    if (id === PROFILE_DOCUMENT_ID)
      result.profile = null
    else if (local.reminderIds.has(id))
      result.reminders.removed.push(id)
    else if (local.intentionIds.has(id))
      result.intentions.removed.push(id)
  }
  return result
}
