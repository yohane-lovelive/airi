import type { Intention } from '@proj-airi/core-agent'

import type { IntentionRecord } from '../intentions.repo'

/** In-memory intentions for Node tests, which have no IndexedDB. */
const records = new Map<string, IntentionRecord>()

export const intentionsRepo = {
  async list() {
    return [...records.values()].sort((left, right) => left.intention.createdAt - right.intention.createdAt)
  },
  async add(intention: Intention) {
    records.set(intention.id, { id: intention.id, intention, updatedAt: intention.createdAt })
  },
  async remove(ids: string[]) {
    return ids.filter(id => records.delete(id))
  },
  async clear() {
    records.clear()
  },
}
