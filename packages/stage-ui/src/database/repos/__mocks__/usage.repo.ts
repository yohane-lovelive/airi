import type { UsageCall, UsageRecord } from '../../../libs/usage'

import { addUsageCall, usageDayOf, usageKeyOf } from '../../../libs/usage'

/** In-memory usage for Node tests, which have no IndexedDB. */
const records = new Map<string, UsageRecord>()

export const usageRepo = {
  async list() {
    return [...records.values()].sort((left, right) => left.day.localeCompare(right.day))
  },
  async add(call: UsageCall) {
    const key = usageKeyOf({ day: usageDayOf(call.at), purpose: call.purpose, model: call.model })
    records.set(key, addUsageCall(records.get(key), call))
  },
  async clear() {
    records.clear()
  },
}
