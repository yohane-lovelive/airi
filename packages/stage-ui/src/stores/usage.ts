import type { UsageCall, UsageRecord } from '../libs/usage'

import { errorMessageFrom } from '@moeru/std'
import { useBroadcastChannel } from '@vueuse/core'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

import { usageRepo } from '../database/repos/usage.repo'

export type { UsageCall, UsagePurpose, UsageRecord, UsageTotals } from '../libs/usage'
export { firstKeptUsageDay, USAGE_PURPOSES, usageByPurpose, usageDayOf } from '../libs/usage'

/**
 * The tokens and images of model calls on this device, for each day, purpose, and model.
 * The LLM store records each finished stream. IndexedDB keeps 30 days. After each record, the other windows read them again.
 * The records never sync, and they hold no cost. The provider site shows the exact cost.
 *
 * Use when:
 * - A view shows how much each purpose used, for example Settings or the inspector.
 *
 * Returns:
 * - The stored records, `record` for a finished stream, and `resetState`.
 */
export const useUsageStore = defineStore('usage', () => {
  const records = ref<UsageRecord[]>([])
  const { data: changed, post } = useBroadcastChannel<number, number>({ name: 'airi:usage' })
  let pendingLoad: Promise<void> = Promise.resolve()

  /** Reads the records again, after the reads that started before. */
  function load() {
    pendingLoad = pendingLoad.catch(() => {}).then(async () => {
      records.value = await usageRepo.list()
    })
    return pendingLoad
  }

  /** Records one finished stream. A failure only logs, because usage must never fail a reply. */
  async function record(call: UsageCall) {
    try {
      await usageRepo.add(call)
      await load()
      post(call.at)
    }
    catch (error) {
      console.warn('[usage] Failed to record a model call:', errorMessageFrom(error))
    }
  }

  async function resetState() {
    await usageRepo.clear()
    await load()
    post(Date.now())
  }

  function reload() {
    void load().catch(error => console.warn('[usage] Failed to read the usage:', errorMessageFrom(error)))
  }
  watch(changed, reload)
  reload()

  return {
    records,
    record,
    resetState,
  }
})
