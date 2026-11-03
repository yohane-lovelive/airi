import type { Database } from '../../libs/db'
import type { PushedField } from './field-sync'

import { Buffer } from 'node:buffer'

import { createBadRequestError, createPayloadTooLargeError } from '@proj-airi/http-error-shared'

import { autonomyRecordFields, autonomyRecords } from '../../schemas/autonomy-records'
import { createFieldSyncStore } from './field-sync'

/** The kinds of records. The client checks the content of each kind, because the server does not know its shape. */
const RECORD_KINDS = new Set(['reminder', 'intention', 'profile'])

/** A reminder or an intention is a short JSON object. A larger value is more likely an error. */
const MAX_RECORD_BYTES = 16 * 1024

function isPlainObject(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertRecordFields(fields: PushedField[]) {
  const invalid: string[] = []
  const tooLarge: string[] = []
  for (const field of fields) {
    if ('removed' in field) {
      if (field.key !== 'kind' && field.key !== 'record')
        invalid.push(field.key)
      continue
    }
    if (field.key === 'kind') {
      if (typeof field.value !== 'string' || !RECORD_KINDS.has(field.value))
        invalid.push(field.key)
    }
    else if (field.key === 'record') {
      if (!isPlainObject(field.value))
        invalid.push(field.key)
      else if (Buffer.byteLength(JSON.stringify(field.value), 'utf8') > MAX_RECORD_BYTES)
        tooLarge.push(field.key)
    }
    else {
      invalid.push(field.key)
    }
  }
  if (invalid.length > 0)
    throw createBadRequestError('Invalid autonomy record field', 'INVALID_REQUEST', invalid)
  if (tooLarge.length > 0)
    throw createPayloadTooLargeError('Autonomy record too large', 'PAYLOAD_TOO_LARGE', tooLarge)
}

/** Reminders and intentions stay few. 2,000 records of some hundred bytes fit with room. */
const RECORD_LIMITS = { maxDocuments: 2_000, maxBytes: 4 * 1024 * 1024 }

/** Enough to undo a recent change. Records have no history UI. */
const RECORD_HISTORY = {
  revisionsPerKey: 5,
  deletedDocumentRetentionMs: 30 * 24 * 60 * 60 * 1000,
  maxHistoryBytes: 4 * 1024 * 1024,
}

/**
 * Stores the reminders, intentions, and owner profile that a user syncs between devices.
 *
 * Use when:
 * - A device syncs its reminders and intentions, so the device that holds the floor runs them.
 *
 * Expects:
 * - Each document has a `kind` of `reminder`, `intention`, or `profile`, and a `record` object. The client checks the record.
 */
export function createAutonomyRecordService(db: Database) {
  return createFieldSyncStore(db, { documents: autonomyRecords, fields: autonomyRecordFields }, {
    validate: assertRecordFields,
    limits: RECORD_LIMITS,
    history: RECORD_HISTORY,
  })
}

export type AutonomyRecordService = ReturnType<typeof createAutonomyRecordService>
