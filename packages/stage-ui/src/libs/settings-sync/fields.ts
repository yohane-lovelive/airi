import type { DocumentFields, LocalDocumentChanges } from '../document-sync'
import type { SettingsSyncGroup } from './groups'

import { SETTINGS_SYNC_GROUPS } from './groups'

function isGroup(id: string): id is SettingsSyncGroup {
  return Object.hasOwn(SETTINGS_SYNC_GROUPS, id)
}

/**
 * Reads the synchronized settings of this device, one document for each group.
 *
 * A field value is the raw stored string, so the sync code does not know the
 * type of a setting. A group without any stored key is left out.
 */
export function readSettingsDocuments(storage: Storage): Record<string, DocumentFields> {
  const documents: Record<string, DocumentFields> = {}
  for (const [group, keys] of Object.entries(SETTINGS_SYNC_GROUPS)) {
    const fields: DocumentFields = {}
    for (const key of keys) {
      const value = storage.getItem(key)
      if (value !== null)
        fields[key] = value
    }
    if (Object.keys(fields).length > 0)
      documents[group] = fields
  }
  return documents
}

/** One stored value that changed, as a `storage` event reports it. */
export interface SettingChange {
  key: string
  oldValue: string | null
  newValue: string | null
}

/**
 * Sends the `storage` event that VueUse reads for a write in this window. A browser sends the event only to the
 * other windows, so without it an open setting in this window keeps its old value.
 */
export function notifyThisWindow(change: SettingChange) {
  window.dispatchEvent(new StorageEvent('storage', { ...change, storageArea: localStorage }))
}

/**
 * Writes the settings that another device changed.
 *
 * - An upsert holds the complete group. A key of the group that it lacks is removed.
 * - A removed group removes all its keys, so each store goes back to its default.
 * - A conflict copy is dropped. A group has a fixed id, so the server value wins.
 *
 * `notify` gets each written value. In a browser, it sends the `storage` event
 * that VueUse reads, so an open setting in this window updates. Other windows
 * get the native event.
 *
 * @returns The groups that this version of the app does not know. The run keeps their sync state, so it does not delete them on the server.
 */
export function applySettingsChanges(storage: Storage, changes: LocalDocumentChanges, notify: (change: SettingChange) => void): { rejected: string[] } {
  const rejected: string[] = []

  function write(key: string, newValue: string | null) {
    const oldValue = storage.getItem(key)
    if (oldValue === newValue)
      return
    if (newValue === null)
      storage.removeItem(key)
    else
      storage.setItem(key, newValue)
    notify({ key, oldValue, newValue })
  }

  for (const [group, fields] of Object.entries(changes.upserts)) {
    if (!isGroup(group)) {
      rejected.push(group)
      continue
    }
    for (const key of SETTINGS_SYNC_GROUPS[group]) {
      const value = fields[key]
      write(key, typeof value === 'string' ? value : null)
    }
  }

  for (const group of changes.removals) {
    if (!isGroup(group))
      continue
    for (const key of SETTINGS_SYNC_GROUPS[group])
      write(key, null)
  }

  return { rejected }
}
