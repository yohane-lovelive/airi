import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import type { ForegroundWindow } from '../libs/perception/exclusion'
import type { ScreenSource } from '../libs/perception/screen-source'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { createSyncedPiniaPlugin } from 'pinia-plugin-synced'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { FRAME_LIMITS } from '../libs/perception/frame-ring'
import { usePerceptionStore } from './perception'
import { usePerceptionRunnerStore } from './perception-runner'
import { usePerceptionStatusStore } from './perception-status'

const contexts: Array<{ pinia: ReturnType<typeof createPinia>, runtime: SyncedPiniaRuntime }> = []
const timers: ReturnType<typeof setInterval>[] = []

/** A screen that is a canvas. Its stream is live, so the runner takes real frames from it. */
function canvasSource(options: { foreground?: () => ForegroundWindow, needsGesture?: boolean, steady?: boolean } = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 180
  const context = canvas.getContext('2d')!
  context.fillStyle = '#3366ff'
  context.fillRect(0, 0, 320, 180)
  let interrupt: ((interrupted: boolean) => void) | undefined
  const streams: MediaStream[] = []
  const source: ScreenSource = {
    supported: true,
    needsGesture: options.needsGesture ?? false,
    start: vi.fn(async () => {
      const stream = canvas.captureStream(10)
      streams.push(stream)
      return stream
    }),
    ...(options.foreground ? { foreground: async () => options.foreground!() } : {}),
    onInterrupt: (listener) => {
      interrupt = listener
      return () => {
        interrupt = undefined
      }
    },
  }
  // A canvas stream sends a frame only after a draw. A moving screen flickers in one corner. A steady screen draws the
  // same scene again, so frames come, and the scene changes only when the test sets another one.
  let tick = 0
  let scene = 0
  timers.push(setInterval(() => {
    tick += 1
    if (options.steady) {
      const gradient = context.createLinearGradient(0, 0, 320, 180)
      gradient.addColorStop(0, scene ? '#111111' : '#eeeeee')
      gradient.addColorStop(1, scene ? '#eeeeee' : '#111111')
      context.fillStyle = gradient
      context.fillRect(0, 0, 320, 180)
      return
    }
    context.fillStyle = tick % 2 ? '#3366ff' : '#ff6633'
    context.fillRect(0, 0, 40, 40)
  }, 50))
  return { source, streams, interrupt: (value: boolean) => interrupt?.(value), setScene: (value: number) => (scene = value) }
}

async function createLeader(source: ScreenSource) {
  const pinia = createPinia()
  const runtime = createSyncedPiniaPlugin({ callTimeout: 1000, leadership: 'leader-only', namespace: `perception:${crypto.randomUUID()}` })
  pinia.use(runtime.plugin)
  createApp({}).use(pinia)
  contexts.push({ pinia, runtime })
  setActivePinia(pinia)
  await vi.waitFor(() => expect(runtime.isLeader()).toBe(true))
  const runner = usePerceptionRunnerStore()
  runner.initialize(runtime, source)
  return { runner, perception: usePerceptionStore(), status: usePerceptionStatusStore() }
}

describe('usePerceptionRunnerStore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    for (const timer of timers.splice(0))
      clearInterval(timer)
    for (const context of contexts.splice(0)) {
      context.runtime.dispose()
      disposePinia(context.pinia)
    }
  })

  it('does not capture until the owner turns perception on', async () => {
    const screen = canvasSource()
    const { status } = await createLeader(screen.source)

    expect(screen.source.start).not.toHaveBeenCalled()
    expect(status.status.state).toBe('off')
  })

  it('keeps encoded frames in memory while it runs, and drops them on a pause', async () => {
    const screen = canvasSource()
    const { runner, perception, status } = await createLeader(screen.source)

    perception.enabled = true
    await expect.poll(() => runner.frames().length, { timeout: 5_000 }).toBeGreaterThan(1)
    const [frame] = runner.frames()
    expect(frame.image.type).toBe('image/jpeg')
    expect(frame.thumbnail).toHaveLength(FRAME_LIMITS.thumbnailWidth * FRAME_LIMITS.thumbnailHeight)
    expect(status.status.state).toBe('running')

    perception.paused = true
    await expect.poll(() => status.status.state).toBe('paused')
    expect(runner.frames()).toHaveLength(0)
    expect(screen.streams[0].getVideoTracks()[0].readyState).toBe('ended')
  })

  it('skips the frames of an excluded window in front', async () => {
    let window: ForegroundWindow = { title: 'Vault', app: 'Bitwarden' }
    const screen = canvasSource({ foreground: () => window })
    const { runner, perception, status } = await createLeader(screen.source)

    perception.enabled = true
    await expect.poll(() => status.status.excluded, { timeout: 5_000 }).toBeGreaterThan(1)
    expect(runner.frames()).toHaveLength(0)
    expect(status.status).toMatchObject({ excludedNow: true, foregroundApp: 'Bitwarden', knowsForeground: true })

    window = { title: 'Game', app: 'Game' }
    await expect.poll(() => runner.frames().length, { timeout: 5_000 }).toBeGreaterThan(0)
  })

  it('stops on a lock and starts again after it', async () => {
    const screen = canvasSource()
    const { runner, perception, status } = await createLeader(screen.source)
    perception.enabled = true
    await expect.poll(() => status.status.state, { timeout: 5_000 }).toBe('running')

    screen.interrupt(true)
    await expect.poll(() => status.status.state).toBe('interrupted')
    expect(runner.frames()).toHaveLength(0)

    screen.interrupt(false)
    await expect.poll(() => status.status.state, { timeout: 5_000 }).toBe('running')
    expect(screen.source.start).toHaveBeenCalledTimes(2)
  })

  it('waits for a click when the source needs one, and ends when the share goes away', async () => {
    const screen = canvasSource({ needsGesture: true })
    const { runner, perception, status } = await createLeader(screen.source)
    perception.enabled = true

    await expect.poll(() => status.status.state).toBe('needs-share')
    expect(screen.source.start).not.toHaveBeenCalled()

    await runner.startFromGesture()
    await expect.poll(() => status.status.state, { timeout: 5_000 }).toBe('running')

    // A share that the owner stops in the browser ends the track. `stop` fires no event, so the test dispatches it.
    const [track] = screen.streams[0].getVideoTracks()
    track.stop()
    track.dispatchEvent(new Event('ended'))
    await expect.poll(() => status.status.state).toBe('ended')
    expect(runner.frames()).toHaveLength(0)
  })

  it('reports a scene change from the detectors after the new screen settles', async () => {
    const screen = canvasSource({ steady: true })
    const { runner, perception, status } = await createLeader(screen.source)
    perception.enabled = true
    await expect.poll(() => runner.frames().length, { timeout: 5_000 }).toBeGreaterThan(3)
    expect(runner.events()).toEqual([])

    screen.setScene(1)
    await expect.poll(() => runner.events().length, { timeout: 5_000 }).toBe(1)
    expect(runner.events()[0]).toMatchObject({ type: 'scene-change', familiar: false })
    await expect.poll(() => status.status.events).toHaveLength(1)
  })
})
