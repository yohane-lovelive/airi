import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import { errorMessageFrom } from '@moeru/std'
import { useEventListener } from '@vueuse/core'
import { defineStore } from 'pinia'
import { boolean, object, parse, string } from 'valibot'
import { computed, onScopeDispose, ref, watch } from 'vue'

import { authedFetch } from '../libs/auth-fetch'
import { deviceId } from '../libs/device-id'
import { SERVER_URL } from '../libs/server'
import { Ticker } from '../workers/ticker'
import { useMemorySyncStore } from './memory-sync'

const FLOOR_PATH = '/api/v1/device-floor'
/** Three heartbeats fit in the takeover time of the server. */
const HEARTBEAT_MS = 10_000
/**
 * Without an answer of the server for this time, the device acts as the holder. The owner uses one device at a time,
 * so a server that is down must not keep the character quiet. It is the takeover time of the server.
 */
const ANSWER_HOLD_MS = 30_000

const FloorAnswerSchema = object({ holder: string(), held: boolean(), heartbeatAt: string() })

function floorUrl(path = '') {
  const url = new URL(SERVER_URL)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${FLOOR_PATH}${path}`
  return url
}

/** The last answer of the server, for the runners and the inspector of every window. */
export interface DeviceFloorAnswer {
  holder: string
  held: boolean
  at: number
}

/**
 * Tells whether this device holds the floor: only that device runs autonomous speech and the watch.
 *
 * - Without the memory sync, the floor is not in use, so every device holds it, as before.
 * - With it, the renderer leader sends a heartbeat every 10 seconds, and gives the floor up when the page closes.
 * - Without an answer for 30 seconds, the device holds the floor, so a server outage does not silence it.
 *
 * Use when:
 * - A runner on the leader checks `holdsFloor` before an autonomous turn or a watch check.
 */
export const useDeviceFloorStore = defineStore('device-floor', () => {
  const memorySync = useMemorySyncStore()
  const answer = ref<DeviceFloorAnswer>()
  const now = ref(Date.now())
  const id = deviceId()

  const holdsFloor = computed(() => {
    if (!memorySync.active)
      return true
    const last = answer.value
    return !last || now.value - last.at >= ANSWER_HOLD_MS || last.held
  })

  let leadership: Pick<SyncedPiniaRuntime, 'isLeader' | 'onLeadershipChange'> | undefined

  async function heartbeat() {
    now.value = Date.now()
    if (!leadership?.isLeader() || !memorySync.active)
      return
    try {
      const response = await authedFetch(floorUrl(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: id }),
        signal: AbortSignal.timeout(HEARTBEAT_MS),
      })
      if (!response.ok)
        throw new Error(`Device floor answered ${response.status}`)
      const parsed = parse(FloorAnswerSchema, await response.json())
      answer.value = { holder: parsed.holder, held: parsed.held, at: Date.now() }
    }
    catch (error) {
      console.warn('[device-floor] Heartbeat failed:', errorMessageFrom(error))
    }
  }

  /** Gives the floor up, so the next device takes it at once. The request outlives the page. */
  function release() {
    if (!leadership?.isLeader() || !memorySync.active || !answer.value?.held)
      return
    void authedFetch(floorUrl(`/${id}`), { method: 'DELETE', keepalive: true }).catch(() => {})
  }

  const ticker = new Ticker(HEARTBEAT_MS, () => void heartbeat())
  useEventListener(window, 'pagehide', release)
  watch(() => memorySync.active, (active) => {
    answer.value = undefined
    if (active)
      void heartbeat()
  })

  let stopLeadershipListener: (() => void) | undefined

  /** Starts the heartbeat while this renderer leads. Later calls do nothing. */
  function initialize(syncedPinia: Pick<SyncedPiniaRuntime, 'isLeader' | 'onLeadershipChange'>) {
    if (leadership)
      return
    leadership = syncedPinia
    stopLeadershipListener = syncedPinia.onLeadershipChange((isLeader) => {
      if (isLeader) {
        ticker.start()
        void heartbeat()
      }
      else {
        ticker.stop()
      }
    })
  }

  function dispose() {
    stopLeadershipListener?.()
    stopLeadershipListener = undefined
    ticker.stop()
    leadership = undefined
  }

  onScopeDispose(dispose)

  return {
    deviceId: id,
    answer,
    holdsFloor,
    initialize,
    dispose,
    heartbeat,
  }
}, {
  // The leader sends the heartbeat. The other windows read its answer, for example the inspector.
  synced: {
    state: true,
  },
})
