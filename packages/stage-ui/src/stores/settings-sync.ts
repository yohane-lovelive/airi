import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import type { DocumentSyncClient } from '../libs/document-sync'

import { errorMessageFrom } from '@moeru/std'
import { useDebounceFn, useDocumentVisibility, useEventListener } from '@vueuse/core'
import { defineStore, storeToRefs } from 'pinia'
import { computed, onScopeDispose, watch } from 'vue'

import { documentSyncRepo } from '../database/repos/document-sync.repo'
import { authedFetch } from '../libs/auth-fetch'
import { createDocumentSyncClient, synchronize } from '../libs/document-sync'
import { SETTINGS_SYNC_FLAG } from '../libs/feature-flags'
import { SERVER_URL } from '../libs/server'
import { applySettingsChanges, notifyThisWindow, readSettingsDocuments, SETTINGS_SYNC_KEY_GROUPS } from '../libs/settings-sync'
import { useAuthStore } from './auth'
import { useFeatureFlagsStore } from './feature-flags'

const SETTINGS_PATH = '/api/v1/settings'
const SYNC_STATE_NAME = 'settings'
/** Settings change in bursts, for example while a slider moves. One run after the burst sends them together. */
const CHANGE_DEBOUNCE_MS = 1_500

/**
 * Synchronizes the allowed settings of this device with the account on the server.
 *
 * State model:
 * - `localStorage` holds the settings. All windows of one app share it, so only the renderer leader runs the
 *   synchronization. A setting written in any window reaches the leader as a `storage` event.
 * - The document sync state of the account lives in the sync state repo. This store keeps only the runtime state.
 *
 * Use when:
 * - An app starts its renderer. Call `initialize` once with the synced Pinia runtime.
 *
 * Expects:
 * - The `settings-sync` experiment is on and the user signed in. Otherwise a run does nothing.
 */
export const useSettingsSyncStore = defineStore('settings-sync', () => {
  const { userId } = storeToRefs(useAuthStore())
  const featureFlags = useFeatureFlagsStore()
  const enabled = computed(() => featureFlags.isEnabled(SETTINGS_SYNC_FLAG.key))

  let leadership: SyncedPiniaRuntime | undefined
  let syncClient: DocumentSyncClient | undefined
  let activeRun: Promise<void> | undefined
  let hasQueuedRun = false
  /** True while a run writes received settings, so their own `storage` events do not request another run. */
  let applying = false

  function canRun() {
    return !!leadership?.isLeader() && enabled.value && userId.value !== 'local'
  }

  async function runOnce(ownerId: string) {
    syncClient ??= createDocumentSyncClient({ serverUrl: SERVER_URL, path: SETTINGS_PATH, fetch: authedFetch })

    const { refused } = await synchronize({
      client: syncClient,
      state: await documentSyncRepo.getState(SYNC_STATE_NAME, ownerId) ?? { documents: {} },
      saveState: state => documentSyncRepo.saveState(SYNC_STATE_NAME, ownerId, state),
      // The new account starts its own run from the `userId` watcher.
      isCurrent: () => userId.value === ownerId,
      readLocal: () => readSettingsDocuments(localStorage),
      async applyLocal(changes) {
        applying = true
        try {
          return applySettingsChanges(localStorage, changes, notifyThisWindow)
        }
        finally {
          applying = false
        }
      },
    })
    if (refused.length > 0)
      console.warn('[settings-sync] The server refused these settings groups. They stay on this device:', refused)
  }

  /**
   * Compares the local settings with the server and exchanges the changes.
   * A call during a run queues one more run. Errors are logged, and the next run sends the same changes again.
   */
  async function synchronizeSettings() {
    if (!canRun())
      return
    if (activeRun) {
      hasQueuedRun = true
      return activeRun
    }

    activeRun = (async () => {
      do {
        hasQueuedRun = false
        try {
          await runOnce(userId.value)
        }
        catch (error) {
          console.error('[settings-sync] Synchronization failed:', errorMessageFrom(error))
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

  const requestAfterChange = useDebounceFn(() => void synchronizeSettings(), CHANGE_DEBOUNCE_MS)

  useEventListener(window, 'storage', (event: StorageEvent) => {
    if (applying || event.storageArea !== localStorage || event.key === null || !SETTINGS_SYNC_KEY_GROUPS.has(event.key))
      return
    void requestAfterChange()
  })
  watch(userId, () => void synchronizeSettings())
  watch(enabled, (on) => {
    if (on)
      void synchronizeSettings()
  })
  const visibility = useDocumentVisibility()
  watch(visibility, (state) => {
    if (state === 'visible')
      void synchronizeSettings()
  })

  let stopLeadershipListener: (() => void) | undefined

  /** Starts the synchronization in the renderer leader. Later calls do nothing. */
  function initialize(syncedPinia: SyncedPiniaRuntime) {
    if (leadership)
      return
    leadership = syncedPinia
    stopLeadershipListener = syncedPinia.onLeadershipChange((isLeader) => {
      if (isLeader)
        void synchronizeSettings()
    })
    void synchronizeSettings()
  }

  function dispose() {
    stopLeadershipListener?.()
    stopLeadershipListener = undefined
    leadership = undefined
  }

  onScopeDispose(dispose)

  return {
    enabled,
    initialize,
    dispose,
    synchronizeSettings,
  }
})
