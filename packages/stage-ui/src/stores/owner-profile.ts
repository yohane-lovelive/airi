import localforage from 'localforage'

import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { useBroadcastChannel } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { PROFILE_DOCUMENT_ID } from '../libs/autonomy-sync'
import { MEMORY_WORK_LIMITS } from '../libs/memory-work'

/** The owner profile: a short summary of the memories about the owner, and the time of its last change. */
export interface OwnerProfile {
  text: string
  updatedAt: number
}

const records = localforage.createInstance({ name: 'airi-owner-profile', storeName: 'profile' })

/**
 * The owner profile, which the system prompt of an owner conversation holds while it is on.
 *
 * - The memory work writes it again after a pass that saved facts. The owner can edit or clear it in Settings.
 * - IndexedDB keeps it, and the autonomy sync carries it to other devices.
 *
 * Use when:
 * - The chat builds the system prompt, the memory work writes the profile, or Settings shows it.
 */
export const useOwnerProfileStore = defineStore('owner-profile', () => {
  const enabled = useLocalStorageManualReset<boolean>('memory/owner-profile-enabled', false)
  const profile = ref<OwnerProfile>()
  /** Counts the changes in any window. A sync of other devices does not count. */
  const changeCount = ref(0)
  let syncEdits = 0
  const { data: changed, post } = useBroadcastChannel<number, number>({ name: 'airi:owner-profile' })
  let pendingLoad: Promise<void> = Promise.resolve()

  function load() {
    pendingLoad = pendingLoad.catch(() => {}).then(async () => {
      const startedAt = syncEdits
      const stored = await records.getItem<OwnerProfile>(PROFILE_DOCUMENT_ID)
      if (startedAt === syncEdits)
        profile.value = stored ?? undefined
    })
    return pendingLoad
  }

  function ready() {
    return pendingLoad.catch(() => {})
  }

  async function save(next: OwnerProfile | undefined) {
    if (next)
      await records.setItem<OwnerProfile>(PROFILE_DOCUMENT_ID, { ...next })
    else
      await records.removeItem(PROFILE_DOCUMENT_ID)
  }

  /** Writes the profile. A long text is cut, so it stays near its budget in every request. */
  async function set(text: string) {
    const trimmed = text.trim().slice(0, MEMORY_WORK_LIMITS.profileMaxChars)
    await save(trimmed ? { text: trimmed, updatedAt: Date.now() } : undefined)
    changeCount.value += 1
    await load()
    post(Date.now())
  }

  async function clear() {
    await set('')
  }

  /** Applies the profile of a sync round. It writes it at once, before it awaits anything, as the sync needs. */
  function applySyncProfile(next: OwnerProfile | undefined) {
    syncEdits += 1
    profile.value = next
    pendingLoad = pendingLoad.catch(() => {}).then(() => save(next))
    const stored = pendingLoad
    void load()
    return stored.then(() => post(Date.now()))
  }

  async function resetState() {
    enabled.reset()
    await records.clear()
    await load()
    post(Date.now())
  }

  watch(changed, () => {
    changeCount.value += 1
    void load().catch(error => console.warn('[owner-profile] Failed to read the profile:', errorMessageFrom(error)))
  })
  void load().catch(error => console.warn('[owner-profile] Failed to read the profile:', errorMessageFrom(error)))

  return {
    enabled,
    profile,
    changeCount: computed(() => changeCount.value),
    ready,
    set,
    clear,
    applySyncProfile,
    resetState,
  }
})
