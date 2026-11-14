import type { Database } from '../../libs/db'
import type { PushedField } from './field-sync'

import { createBadRequestError, createPayloadTooLargeError } from '@proj-airi/http-error-shared'

import { syncedSettingFields, syncedSettings } from '../../schemas/settings-sync'
import { createFieldSyncStore } from './field-sync'

/**
 * A `localStorage` key of the client, for example `settings/speech/voice`. The
 * server does not know the allow list of the client, so a client can add a
 * group without a server change.
 */
const SETTING_KEY_PATTERN = /^[\w.\-/]+$/

/** A setting is a short string. A larger value is more likely an error than a real setting. */
const MAX_VALUE_BYTES = 64 * 1024

function assertSettingFields(fields: PushedField[]) {
  const invalid: string[] = []
  const tooLarge: string[] = []

  for (const field of fields) {
    if (!SETTING_KEY_PATTERN.test(field.key)) {
      invalid.push(field.key)
      continue
    }
    if ('removed' in field)
      continue
    // The client sends the raw stored string. The store keeps the value as JSON text.
    if (typeof field.value !== 'string')
      invalid.push(field.key)
    else if (new TextEncoder().encode(JSON.stringify(field.value)).byteLength > MAX_VALUE_BYTES)
      tooLarge.push(field.key)
  }

  if (invalid.length > 0)
    throw createBadRequestError('Invalid setting field', 'INVALID_REQUEST', invalid)
  if (tooLarge.length > 0)
    throw createPayloadTooLargeError('Setting value too large', 'PAYLOAD_TOO_LARGE', tooLarge)
}

/** The client has about 10 groups, and the allowed settings take a few kilobytes. */
const SETTINGS_LIMITS = { maxDocuments: 32, maxBytes: 1024 * 1024 }

/** Enough to undo recent changes. Settings have no history UI yet. */
const SETTINGS_HISTORY = {
  revisionsPerKey: 20,
  deletedDocumentRetentionMs: 30 * 24 * 60 * 60 * 1000,
  maxHistoryBytes: 4 * 1024 * 1024,
}

/** Stores the settings that a user synchronizes between devices. */
export function createSettingsSyncService(db: Database) {
  return createFieldSyncStore(db, { documents: syncedSettings, fields: syncedSettingFields }, {
    validate: assertSettingFields,
    limits: SETTINGS_LIMITS,
    history: SETTINGS_HISTORY,
  })
}

export type SettingsSyncService = ReturnType<typeof createSettingsSyncService>
