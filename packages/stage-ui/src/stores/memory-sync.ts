import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import type { DocumentSyncClient } from '../libs/document-sync'

import { errorMessageFrom } from '@moeru/std'
import { useDebounceFn, useDocumentVisibility } from '@vueuse/core'
import { defineStore, storeToRefs } from 'pinia'
import { computed, onScopeDispose, readonly, ref, watch } from 'vue'

import { documentSyncRepo } from '../database/repos/document-sync.repo'
import { authedFetch } from '../libs/auth-fetch'
import { createDocumentSyncClient, synchronize } from '../libs/document-sync'
import { MEMORY_SYNC_FLAG } from '../libs/feature-flags'
import { memoryToFields } from '../libs/memory-sync'
import { SERVER_URL } from '../libs/server'
import { useAuthStore } from './auth'
import { useFeatureFlagsStore } from './feature-flags'
import { useMemoryStore } from './memory'

const MEMORIES_PATH = '/api/v1/memories'
const SYNC_STATE_NAME = 'memories'
/** A run can write several facts in one turn. One sync after the turn sends them together. */
const CHANGE_DEBOUNCE_MS = 1_500
/** A run that only reads the changes of other devices starts at most this often. */
const PULL_INTERVAL_MS = 10_000

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
  /** Whether this device syncs memories, so the server has them. Recall by meaning and the short index need it. */
  const active = computed(() => enabled.value && userId.value !== 'local')
  /** The time when the last run ended without an error. Entries that changed after it are not on the server yet. */
  const lastSyncedAt = ref<number>()

  let leadership: Pick<SyncedPiniaRuntime, 'isLeader' | 'onLeadershipChange'> | undefined
  let syncClient: DocumentSyncClient | undefined
  let activeRun: Promise<void> | undefined
  let hasQueuedRun = false
  let lastRunStartedAt = Number.NEGATIVE_INFINITY

  function canRun() {
    return !!leadership?.isLeader() && active.value
  }

  async function runOnce(ownerId: string) {
    syncClient ??= createDocumentSyncClient({ serverUrl: SERVER_URL, path: MEMORIES_PATH, fetch: authedFetch })
    // A read of another window can still be on its way. The run must see every entry, or it reads a missing one as a deletion.
    await memory.ready()
    const startedAt = Date.now()

    const { refused } = await synchronize({
      client: syncClient,
      state: await documentSyncRepo.getState(SYNC_STATE_NAME, ownerId) ?? { documents: {} },
      saveState: state => documentSyncRepo.saveState(SYNC_STATE_NAME, ownerId, state),
      isCurrent: () => userId.value === ownerId,
      readLocal: () => Object.fromEntries(memory.entries.map(entry => [entry.id, memoryToFields(entry)])),
      applyLocal: changes => memory.applySyncChanges(changes),
    })
    if (refused.length > 0)
      console.warn('[memory-sync] The server refused these memories. They stay on this device:', refused)
    lastSyncedAt.value = startedAt
  }

  /**
   * Compares the local memories with the server and exchanges the changes.
   * A call during a run queues one more run. Errors are logged, and the next run sends the same changes again.
   */
  async function synchronizeMemories() {
    if (!canRun())
      return
    if (activeRun) {
      hasQueuedRun = true
      return activeRun
    }

    activeRun = (async () => {
      do {
        hasQueuedRun = false
        lastRunStartedAt = Date.now()
        try {
          await runOnce(userId.value)
        }
        catch (error) {
          console.error('[memory-sync] Synchronization failed:', errorMessageFrom(error))
        }
      } while (hasQueuedRun && canRun())
    })()

    try {
      await activeRun
    }
    finally {
      activeRun = undefined
    }
  }

  const requestAfterChange = useDebounceFn(() => void synchronizeMemories(), CHANGE_DEBOUNCE_MS)

  function requestPull() {
    if (Date.now() - lastRunStartedAt >= PULL_INTERVAL_MS)
      void synchronizeMemories()
  }

  watch(() => memory.changeCount, () => void requestAfterChange())
  watch(userId, () => {
    lastSyncedAt.value = undefined
    void synchronizeMemories()
  })
  watch(enabled, (on) => {
    if (on)
      void synchronizeMemories()
  })
  const visibility = useDocumentVisibility()
  watch(visibility, (state) => {
    if (state === 'visible')
      requestPull()
  })

  let stopLeadershipListener: (() => void) | undefined

  /** Starts the sync in the renderer leader. Later calls do nothing. */
  function initialize(syncedPinia: Pick<SyncedPiniaRuntime, 'isLeader' | 'onLeadershipChange'>) {
    if (leadership)
      return
    leadership = syncedPinia
    // The runtime calls the listener at once with the current state, so this also starts the first run.
    let wasLeader = false
    stopLeadershipListener = syncedPinia.onLeadershipChange((isLeader) => {
      if (isLeader && !wasLeader)
        void synchronizeMemories()
      wasLeader = isLeader
    })
  }

  function dispose() {
    stopLeadershipListener?.()
    stopLeadershipListener = undefined
    leadership = undefined
  }

  onScopeDispose(dispose)

  return {
    active,
    lastSyncedAt: readonly(lastSyncedAt),
    initialize,
    dispose,
    synchronizeMemories,
  }
})
