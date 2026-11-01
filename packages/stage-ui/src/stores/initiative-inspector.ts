import type { InitiativeReadout, InitiativeRhythm } from '@proj-airi/core-agent'

import { defineStore } from 'pinia'
import { ref } from 'vue'

/** A watching window counts for this time after its last mark. A window that closes stops the publish by itself. */
export const INSPECTOR_WATCH_HOLD_MS = 15_000
/** A watching window marks itself this often, well inside the hold time. */
export const INSPECTOR_WATCH_REFRESH_MS = 5_000

/** What the runner knows about the daily rhythm: whether the owner is away, and the last greeting or welcome back. */
export interface InitiativeInspectorRhythm {
  awaySince?: number
  lastRhythm?: { rhythm: InitiativeRhythm, at: number }
}

/** One readout of the policy and its time. */
export interface InitiativeInspectorSnapshot {
  at: number
  readout: InitiativeReadout
  rhythm: InitiativeInspectorRhythm
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

  function publish(readout: InitiativeReadout, at: number, rhythm: InitiativeInspectorRhythm = {}) {
    snapshot.value = { at, readout, rhythm }
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
