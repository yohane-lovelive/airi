import type { Intention } from '@proj-airi/core-agent'

import localforage from 'localforage'

/** One intention and the time of its last change. */
export interface IntentionRecord {
  id: string
  intention: Intention
  updatedAt: number
}

/** A removed intention stays as a tombstone with the time of the removal, so a later sync can remove it on other devices. */
interface IntentionTombstone {
  id: string
  updatedAt: number
  deleted: true
}

type StoredIntention = IntentionRecord | IntentionTombstone

const records = localforage.createInstance({ name: 'airi-intentions', storeName: 'intentions' })

/** Runs one write. Every write of every window takes this lock, so two windows never overwrite each other. */
function write<T>(run: () => Promise<T>) {
  return navigator.locks.request('airi:intentions', run)
}

/** The intentions on this device, one record for each intention, keyed by the intention id. */
export const intentionsRepo = {
  /** The intentions that are not removed, oldest first. Ended ones are still here until a removal. */
  async list() {
    const stored: StoredIntention[] = []
    await records.iterate<StoredIntention, void>((record) => {
      stored.push(record)
    })
    return stored
      .filter((record): record is IntentionRecord => !('deleted' in record))
      .sort((left, right) => left.intention.createdAt - right.intention.createdAt)
  },
  async add(intention: Intention) {
    // An intention can come from a reactive list that IndexedDB cannot clone, so it goes in as a plain copy.
    await write(() => records.setItem<IntentionRecord>(intention.id, { id: intention.id, intention: { ...intention }, updatedAt: intention.createdAt }))
  },
  /** Replaces each intention with a tombstone. Resolves to the ids that were stored and not removed before. */
  async remove(ids: string[], updatedAt: number) {
    return write(async () => {
      const removed: string[] = []
      for (const id of ids) {
        const stored = await records.getItem<StoredIntention>(id)
        if (!stored || 'deleted' in stored)
          continue
        await records.setItem<IntentionTombstone>(id, { id, updatedAt, deleted: true })
        removed.push(id)
      }
      return removed
    })
  },
  /** Deletes every record, tombstones too. Only deleting all data uses it. */
  async clear() {
    await write(() => records.clear())
  },
}
