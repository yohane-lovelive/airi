import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from './auth'
import { useDeviceFloorStore } from './device-floor'
import { useFeatureFlagsStore } from './feature-flags'

const { authedFetch } = vi.hoisted(() => ({
  authedFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))

// The server is the boundary. The fake answers the floor route.
vi.mock('../libs/auth-fetch', () => ({ authedFetch }))

function leaderRuntime(): Pick<SyncedPiniaRuntime, 'isLeader' | 'onLeadershipChange'> {
  return {
    isLeader: () => true,
    onLeadershipChange: (listener) => {
      listener(true)
      return () => {}
    },
  }
}

function floorCalls(method: string) {
  return authedFetch.mock.calls.filter(([url, init]) => String(url).includes('/api/v1/device-floor') && init?.method === method)
}

/** Answers the floor route with `held`, and every other route with 404. */
function answerFloor(held: boolean | 'down') {
  authedFetch.mockImplementation(async (url) => {
    if (!String(url).includes('/api/v1/device-floor'))
      return new Response(null, { status: 404 })
    if (held === 'down')
      throw new TypeError('fetch failed')
    return Response.json({ holder: held ? 'this' : 'other-device', held, heartbeatAt: new Date().toISOString() })
  })
}

describe('device floor store', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    authedFetch.mockReset()
    answerFloor(true)
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(() => {
    disposePinia(pinia)
    vi.useRealTimers()
  })

  function signInWithMemorySync() {
    useAuthStore().user = { id: 'user-1', name: 'user-1', email: 'user-1@example.test', emailVerified: true, createdAt: new Date(), updatedAt: new Date() }
    useFeatureFlagsStore().setPreference('memory-sync', true)
  }

  it('holds the floor without asking while the memory sync is off', async () => {
    const floor = useDeviceFloorStore()
    floor.initialize(leaderRuntime())
    await floor.heartbeat()

    expect(floor.holdsFloor).toBe(true)
    expect(floorCalls('PUT')).toEqual([])
  })

  it('stays quiet while another device holds the floor, and speaks again after 30 seconds without an answer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    signInWithMemorySync()
    answerFloor(false)
    const floor = useDeviceFloorStore()
    floor.initialize(leaderRuntime())
    await floor.heartbeat()

    expect(floor.holdsFloor).toBe(false)
    expect(JSON.parse(String(floorCalls('PUT').at(-1)![1]?.body))).toEqual({ deviceId: floor.deviceId })

    answerFloor('down')
    vi.setSystemTime(Date.now() + 29_000)
    await floor.heartbeat()
    expect(floor.holdsFloor).toBe(false)

    vi.setSystemTime(Date.now() + 1_000)
    await floor.heartbeat()
    expect(floor.holdsFloor).toBe(true)
  })

  it('gives the floor up when the page closes, after the synced runtime has ended', async () => {
    signInWithMemorySync()
    // `setupSynced` ends the runtime on `pagehide` before the stores hear the event, so `isLeader()` then answers false.
    let ended = false
    window.addEventListener('pagehide', () => {
      ended = true
    }, { once: true })
    const floor = useDeviceFloorStore()
    floor.initialize({ ...leaderRuntime(), isLeader: () => !ended })
    await floor.heartbeat()
    expect(floor.holdsFloor).toBe(true)

    window.dispatchEvent(new Event('pagehide'))

    const [[url, init]] = floorCalls('DELETE')
    expect(String(url)).toMatch(new RegExp(`/api/v1/device-floor/${floor.deviceId}$`))
    expect(init?.keepalive).toBe(true)
  })
})
