import type { IntentionRequest } from '@proj-airi/core-agent'

import { errorMessageFrom } from '@moeru/std'
import { createIntention, openIntentions } from '@proj-airi/core-agent'
import { useBroadcastChannel } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { intentionsRepo } from '../database/repos/intentions.repo'

export type { Intention, IntentionRequest } from '@proj-airi/core-agent'

/**
 * What the character wants to do later, for example "ask the owner about the trip".
 * The model writes them with the intention tools, and autonomous speech brings them up.
 * IndexedDB keeps them. After each change, the other windows read them again.
 *
 * Use when:
 * - The intention tools add, list, or finish an intention.
 * - The initiative runner reads the open intentions for the drive and the situation block.
 *
 * Returns:
 * - All stored intentions, `openAt` for the open ones at a time, and actions that change them.
 */
export const useIntentionsStore = defineStore('intentions', () => {
  const records = ref<Awaited<ReturnType<typeof intentionsRepo.list>>>([])
  const { data: changed, post } = useBroadcastChannel<string[], string[]>({ name: 'airi:intentions' })
  let pendingLoad: Promise<void> = Promise.resolve()

  const intentions = computed(() => records.value.map(record => record.intention))

  /** Reads the intentions again, after the reads that started before. */
  function load() {
    pendingLoad = pendingLoad.catch(() => {}).then(async () => {
      records.value = await intentionsRepo.list()
    })
    return pendingLoad
  }

  async function publish(ids: string[]) {
    await load()
    post(ids)
  }

  /** The intentions that are open at `now`, oldest first. */
  function openAt(now: number) {
    return openIntentions(intentions.value, now)
  }

  /**
   * Adds an intention. Ended intentions are removed first, so they do not fill the store.
   * On a refusal, `reason` tells the model what to change.
   */
  async function add(request: IntentionRequest) {
    await load()
    const now = Date.now()
    const ended = intentions.value.filter(intention => intention.expiresAt <= now).map(intention => intention.id)
    if (ended.length)
      await intentionsRepo.remove(ended, now)
    const result = createIntention({ id: nanoid(8), request, now, open: intentions.value })
    if (!result.ok)
      return result
    await intentionsRepo.add(result.intention)
    await publish([...ended, result.intention.id])
    return result
  }

  /** Finishes an open intention. Resolves to whether an open intention ended. */
  async function finish(id: string) {
    await load()
    const now = Date.now()
    if (!openAt(now).some(intention => intention.id === id))
      return false
    const removed = await intentionsRepo.remove([id], now)
    await publish(removed)
    return removed.length > 0
  }

  async function resetState() {
    await intentionsRepo.clear()
    await load()
    post([])
  }

  function reload() {
    void load().catch(error => console.warn('[intentions] Failed to read the intentions:', errorMessageFrom(error)))
  }
  watch(changed, reload)
  reload()

  return {
    intentions,
    openAt,
    add,
    finish,
    resetState,
  }
})
