import type { UsageCall, UsageRecord } from '../../libs/usage'

import localforage from 'localforage'

import { addUsageCall, firstKeptUsageDay, usageDayOf, usageKeyOf } from '../../libs/usage'

const records = localforage.createInstance({ name: 'airi-usage', storeName: 'usage' })

/** The last day that this window removed old records. One removal each day is enough. */
let prunedDay: string | undefined

/** Runs one write. Every write of every window takes this lock, so two windows never lose a call. */
function write<T>(run: () => Promise<T>) {
  return navigator.locks.request('airi:usage', run)
}

/** The model usage on this device, one record for each day, purpose, and model. It never syncs. */
export const usageRepo = {
  /** The records of the kept days, oldest first. */
  async list() {
    const stored: UsageRecord[] = []
    await records.iterate<UsageRecord, void>((record) => {
      stored.push(record)
    })
    return stored.sort((left, right) => left.day.localeCompare(right.day))
  },
  /** Adds one call. On the first call of a day, records before the kept days are removed. */
  async add(call: UsageCall) {
    await write(async () => {
      const key = usageKeyOf({ day: usageDayOf(call.at), purpose: call.purpose, model: call.model })
      await records.setItem<UsageRecord>(key, addUsageCall(await records.getItem<UsageRecord>(key) ?? undefined, call))

      const today = usageDayOf(call.at)
      if (prunedDay === today)
        return
      prunedDay = today
      const firstDay = firstKeptUsageDay(call.at)
      const old = (await records.keys()).filter(stored => stored.slice(0, 10) < firstDay)
      for (const stored of old)
        await records.removeItem(stored)
    })
  },
  /** Deletes every record. Only deleting all data uses it. */
  async clear() {
    await write(() => records.clear())
  },
}
