import type { ScreenEvent } from '@proj-airi/stage-shared/perception'

import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * The state of the capture.
 *
 * - `off`: the owner did not turn perception on.
 * - `paused`: the owner paused perception.
 * - `needs-share`: the web app waits for the owner to choose a share.
 * - `starting`: the capture starts.
 * - `running`: frames come in.
 * - `interrupted`: the screen is locked, or the device sleeps.
 * - `ended`: the shared screen or window went away. The owner starts again in Settings or from the indicator.
 * - `failed`: the capture could not start.
 */
export type PerceptionState = 'off' | 'paused' | 'needs-share' | 'starting' | 'running' | 'interrupted' | 'ended' | 'failed'

/** What the perception runner reports. */
export interface PerceptionStatus {
  state: PerceptionState
  /** Frames in the ring now. */
  frames: number
  /** Bytes of the frames in the ring. */
  bytes: number
  /** Frames that the exclusion list skipped since perception started. */
  excluded: number
  /** The app in front, where the device can tell it. The title stays out, because it can hold private text. */
  foregroundApp?: string
  /** Whether the last frame was skipped by the exclusion list. */
  excludedNow: boolean
  /** Whether the device can tell the window in front. Without it, the exclusion list cannot work. */
  knowsForeground: boolean
  /** The reason of a failed start. */
  error?: string
  /** How much the screen moves now, from 0 to 1. */
  activity: number
  /** The recent screen events, newest last. */
  events: ScreenEvent[]
  updatedAt: number
}

/**
 * The state of screen perception, for the indicator and the inspector in any window.
 * Only the leader captures, and the store replicates what it reports. Another window asks the leader to start with
 * `requestStart`. Nothing persists.
 */
export const usePerceptionStatusStore = defineStore('perception-status', () => {
  const status = ref<PerceptionStatus>({ state: 'off', frames: 0, bytes: 0, excluded: 0, excludedNow: false, knowsForeground: false, activity: 0, events: [], updatedAt: 0 })

  /**
   * Epoch milliseconds of the last start request from a window that does not capture, for example the settings window
   * of the desktop app. The leader starts the capture when it changes.
   */
  const startRequestedAt = ref(0)

  function report(next: PerceptionStatus) {
    status.value = next
  }

  function requestStart() {
    startRequestedAt.value = Date.now()
  }

  return {
    status,
    startRequestedAt,
    report,
    requestStart,
  }
}, {
  synced: {
    state: true,
  },
})
