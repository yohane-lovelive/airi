import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'
import type { MaybeRefOrGetter, WatchSource } from 'vue'

import type { AppliedLocalChanges, DocumentFields, DocumentSyncClient, LocalDocumentChanges } from '../libs/document-sync'

import { errorMessageFrom } from '@moeru/std'
import { useDebounceFn, useDocumentVisibility } from '@vueuse/core'
import { onScopeDispose, readonly, ref, toValue, watch } from 'vue'

import { documentSyncRepo } from '../database/repos/document-sync.repo'
import { authedFetch } from '../libs/auth-fetch'
import { createDocumentSyncClient, synchronize } from '../libs/document-sync'
import { SERVER_URL } from '../libs/server'

/** A run can write several records in one turn. One sync after the burst sends them together. */
const CHANGE_DEBOUNCE_MS = 1_500
/** A run that only reads the changes of other devices starts at most this often. */
const PULL_INTERVAL_MS = 10_000

export interface LeaderDocumentSyncOptions {
  /** The name of the sync state and of the log lines, for example `memories`. */
  name: string
  /** The route of the field store, for example `/api/v1/memories`. */
  path: string
  /** Whether this device syncs now: the experiment is on and the user signed in. */
  active: MaybeRefOrGetter<boolean>
  /** The signed-in user. A change starts a run for the new account. */
  userId: MaybeRefOrGetter<string>
  /** Changes when a window changed the local records. One run follows a burst of changes. */
  changeSignal: WatchSource
  /** Waits for the reads of the local records, so the run never reads a missing record as a deletion. */
  prepare?: () => Promise<void>
  readLocal: () => Record<string, DocumentFields>
  /** Writes the changes of a round. It must write the local records before it awaits anything. */
  applyLocal: (changes: LocalDocumentChanges) => Promise<AppliedLocalChanges>
}

/**
 * Runs the document sync of one feature on the renderer leader.
 *
 * - A run starts after a burst of local changes, on sign-in, when the sync turns on, when this window becomes the
 *   leader, and when the page becomes visible, at most once each 10 seconds.
 * - A call during a run queues one more run. Errors are logged, and the next run sends the same changes again.
 *
 * Use when:
 * - A store syncs records of IndexedDB with the field store of the server, for example memories or reminders.
 *
 * Returns:
 * - `lastSyncedAt`, the start of the last run that ended without an error. Records that changed after it are not on
 *   the server yet.
 */
export function useLeaderDocumentSync(options: LeaderDocumentSyncOptions) {
  const lastSyncedAt = ref<number>()
  let leadership: Pick<SyncedPiniaRuntime, 'isLeader' | 'onLeadershipChange'> | undefined
  let client: DocumentSyncClient | undefined
  let activeRun: Promise<void> | undefined
  let hasQueuedRun = false
  let lastRunStartedAt = Number.NEGATIVE_INFINITY

  function canRun() {
    return !!leadership?.isLeader() && toValue(options.active)
  }

  async function runOnce(ownerId: string) {
    client ??= createDocumentSyncClient({ serverUrl: SERVER_URL, path: options.path, fetch: authedFetch })
    await options.prepare?.()
    const startedAt = Date.now()

    const { refused } = await synchronize({
      client,
      state: await documentSyncRepo.getState(options.name, ownerId) ?? { documents: {} },
      saveState: state => documentSyncRepo.saveState(options.name, ownerId, state),
      isCurrent: () => toValue(options.userId) === ownerId,
      readLocal: options.readLocal,
      applyLocal: options.applyLocal,
    })
    if (refused.length > 0)
      console.warn(`[${options.name}-sync] The server refused these records. They stay on this device:`, refused)
    lastSyncedAt.value = startedAt
  }

  async function synchronizeNow() {
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
          await runOnce(toValue(options.userId))
        }
        catch (error) {
          console.error(`[${options.name}-sync] Synchronization failed:`, errorMessageFrom(error))
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

  const requestAfterChange = useDebounceFn(() => void synchronizeNow(), CHANGE_DEBOUNCE_MS)

  function requestPull() {
    if (Date.now() - lastRunStartedAt >= PULL_INTERVAL_MS)
      void synchronizeNow()
  }

  watch(options.changeSignal, () => void requestAfterChange())
  watch(() => toValue(options.userId), () => {
    lastSyncedAt.value = undefined
    void synchronizeNow()
  })
  watch(() => toValue(options.active), (on) => {
    if (on)
      void synchronizeNow()
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
        void synchronizeNow()
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
    lastSyncedAt: readonly(lastSyncedAt),
    synchronize: synchronizeNow,
    initialize,
    dispose,
  }
}
