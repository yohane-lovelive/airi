import { defineStore, storeToRefs } from 'pinia'
import { computed } from 'vue'

import { useLeaderDocumentSync } from '../composables/use-leader-document-sync'
import { MEMORY_SYNC_FLAG } from '../libs/feature-flags'
import { memoryToFields } from '../libs/memory-sync'
import { useAuthStore } from './auth'
import { useFeatureFlagsStore } from './feature-flags'
import { useMemoryStore } from './memory'

/**
 * Synchronizes the long-term memories of this device with the account on the server.
 *
 * State model:
 * - IndexedDB holds the entries, and every window reads them. Only the renderer leader runs the sync.
 * - A change in any window reaches the leader through the memory store, as `changeCount`.
 * - The server answers a search by meaning only for entries that it has, so `lastSyncedAt` tells which local entries
 *   changed after the last run.
 *
 * Use when:
 * - An app starts its renderer. Call `initialize` once with the synced Pinia runtime.
 *
 * Expects:
 * - The `memory-sync` experiment is on and the user signed in. Otherwise a run does nothing.
 */
export const useMemorySyncStore = defineStore('memory-sync', () => {
  const { userId } = storeToRefs(useAuthStore())
  const featureFlags = useFeatureFlagsStore()
  const memory = useMemoryStore()
  const enabled = computed(() => featureFlags.isEnabled(MEMORY_SYNC_FLAG.key))
  /**
   * Whether this device syncs with the account. Recall by meaning, the short index, the device floor, and the sync of
   * reminders and intentions need it.
   */
  const active = computed(() => enabled.value && userId.value !== 'local')

  const sync = useLeaderDocumentSync({
    name: 'memories',
    path: '/api/v1/memories',
    active,
    userId,
    changeSignal: () => memory.changeCount,
    // A read of another window can still be on its way. The run must see every entry, or it reads a missing one as a deletion.
    prepare: () => memory.ready(),
    readLocal: () => Object.fromEntries(memory.entries.map(entry => [entry.id, memoryToFields(entry)])),
    applyLocal: changes => memory.applySyncChanges(changes),
  })

  return {
    active,
    lastSyncedAt: sync.lastSyncedAt,
    initialize: sync.initialize,
    dispose: sync.dispose,
    synchronizeMemories: sync.synchronize,
  }
})
