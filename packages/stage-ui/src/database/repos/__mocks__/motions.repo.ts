import type { MotionRecord } from '../motions.repo'

/** In-memory motion library for Node tests, which have no IndexedDB. */
const records = new Map<string, MotionRecord>()

export const motionsRepo = {
  async list() {
    return [...records.values()]
  },
  async get(id: string) {
    return records.get(id)
  },
  async put(record: MotionRecord) {
    records.set(record.id, record)
  },
  async change(id: string, next: (stored: MotionRecord | undefined) => MotionRecord | undefined) {
    const record = next(records.get(id))
    if (record)
      records.set(id, record)
    return record
  },
  async remove(id: string) {
    records.delete(id)
  },
  async clear() {
    records.clear()
  },
}
