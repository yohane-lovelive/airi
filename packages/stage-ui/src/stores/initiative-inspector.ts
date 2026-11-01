import type { InitiativeReadout } from '@proj-airi/core-agent'

import { defineStore } from 'pinia'
import { ref } from 'vue'

/** A watching window counts for this time after its last mark. A window that closes stops the publish by itself. */
export const INSPECTOR_WATCH_HOLD_MS = 15_000
/** A watching window marks itself this often, well inside the hold time. */
export const INSPECTOR_WATCH_REFRESH_MS = 5_000

/** One readout of the policy and its time. */
export interface InitiativeInspectorSnapshot {
  at: number
  readout: InitiativeReadout
}

/**
 * What the initiative policy sees, for the inspector in any window.
 *
 * Only the leader holds the policy state. While a window watches, the initiative runner publishes a readout each second,
 * and the store replicates it. Without a watching window, nothing is published, so the inspector costs nothing.
 * Nothing persists, because the policy state lives in memory only.
 *
 * Use when:
 * - The inspector page shows why the character speaks or stays silent. Call `markWatching` while it is open.
 * - The initiative runner publishes a readout. Check `isWatched` first.
 */
export const useInitiativeInspectorStore = defineStore('initiative-inspector', () => {
  /** Epoch milliseconds until which a window counts as watching. `0` when no window watches. */
  const watchingUntil = ref(0)
  /** The last published readout. Undefined until the runner publishes one. */
  const snapshot = ref<InitiativeInspectorSnapshot>()

  /** Marks that a window watches now. */
  function markWatching() {
    watchingUntil.value = Date.now() + INSPECTOR_WATCH_HOLD_MS
  }

  function isWatched(now: number) {
    return watchingUntil.value > now
  }

  function publish(readout: InitiativeReadout, at: number) {
    snapshot.value = { at, readout }
  }

  return {
    watchingUntil,
    snapshot,
    markWatching,
    isWatched,
    publish,
  }
}, {
  synced: {
    state: true,
  },
})
