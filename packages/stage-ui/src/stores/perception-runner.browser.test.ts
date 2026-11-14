import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import type { ForegroundWindow } from '../libs/perception/exclusion'
import type { PerceptionRecorderSink, RecorderEvent, RecorderFrame } from '../libs/perception/recorder'
import type { ScreenSource } from '../libs/perception/screen-source'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { createSyncedPiniaPlugin } from 'pinia-plugin-synced'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { FRAME_LIMITS, SCREEN_FRAME_LIMITS } from '../libs/perception/frame-ring'
import { usePerceptionStore } from './perception'
import { usePerceptionRunnerStore } from './perception-runner'
import { usePerceptionStatusStore } from './perception-status'

const contexts: Array<{ pinia: ReturnType<typeof createPinia>, runtime: SyncedPiniaRuntime }> = []
const timers: ReturnType<typeof setInterval>[] = []

/**
 * A screen that is a canvas. Its stream is live, so the runner takes real frames from it. A capture of an app takes the
 * window that the runner names, or else the window in front, as the desktop does.
 */
function canvasSource(options: { foreground?: () => ForegroundWindow, needsGesture?: boolean, steady?: boolean, windowOpen?: () => boolean } = {}) {
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
    start: vi.fn(async (start?: { app?: string, windowId?: number }) => {
      const stream = canvas.captureStream(10)
      streams.push(stream)
      const windowId = start?.app ? start.windowId ?? options.foreground?.().id : undefined
      return { stream, ...(windowId !== undefined ? { windowId } : {}) }
    }),
    ...(options.foreground ? { foreground: async () => options.foreground!() } : {}),
    ...(options.windowOpen ? { windowOpen: async () => options.windowOpen!() } : {}),
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

async function createLeader(source: ScreenSource, recorder?: PerceptionRecorderSink) {
  const pinia = createPinia()
  const runtime = createSyncedPiniaPlugin({ callTimeout: 1000, leadership: 'leader-only', namespace: `perception:${crypto.randomUUID()}` })
  pinia.use(runtime.plugin)
  createApp({}).use(pinia)
  contexts.push({ pinia, runtime })
  setActivePinia(pinia)
  await vi.waitFor(() => expect(runtime.isLeader()).toBe(true))
  const runner = usePerceptionRunnerStore()
  runner.initialize(runtime, source, recorder)
  return { runner, perception: usePerceptionStore(), status: usePerceptionStatusStore() }
}

describe('usePerceptionRunnerStore', { timeout: 60_000 }, () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
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
    await expect.poll(() => runner.frames().length, { timeout: 15_000 }).toBeGreaterThan(1)
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
    await expect.poll(() => status.status.excluded, { timeout: 15_000 }).toBeGreaterThan(1)
    expect(runner.frames()).toHaveLength(0)
    expect(status.status).toMatchObject({ excludedNow: true, foregroundApp: 'Bitwarden', knowsForeground: true })

    window = { title: 'Game', app: 'Game' }
    await expect.poll(() => runner.frames().length, { timeout: 15_000 }).toBeGreaterThan(0)
  })

  it('stops on a lock and starts again after it', async () => {
    const screen = canvasSource()
    const { runner, perception, status } = await createLeader(screen.source)
    perception.enabled = true
    await expect.poll(() => status.status.state, { timeout: 15_000 }).toBe('running')

    screen.interrupt(true)
    await expect.poll(() => status.status.state).toBe('interrupted')
    expect(runner.frames()).toHaveLength(0)

    screen.interrupt(false)
    await expect.poll(() => status.status.state, { timeout: 15_000 }).toBe('running')
    expect(screen.source.start).toHaveBeenCalledTimes(2)
  })

  it('waits for a click when the source needs one, and ends when the share goes away', async () => {
    const screen = canvasSource({ needsGesture: true })
    const { runner, perception, status } = await createLeader(screen.source)
    perception.enabled = true

    await expect.poll(() => status.status.state).toBe('needs-share')
    expect(screen.source.start).not.toHaveBeenCalled()

    await runner.startFromGesture()
    await expect.poll(() => status.status.state, { timeout: 15_000 }).toBe('running')

    // A share that the owner stops in the browser ends the track. `stop` fires no event, so the test dispatches it.
    const [track] = screen.streams[0].getVideoTracks()
    expect(screen.source.start).toHaveLastResolvedWith({ stream: screen.streams[0] })
    track.stop()
    track.dispatchEvent(new Event('ended'))
    await expect.poll(() => status.status.state).toBe('ended')
    expect(runner.frames()).toHaveLength(0)
  })

  it('reports a scene change from the detectors after the new screen settles', async () => {
    const screen = canvasSource({ steady: true })
    const { runner, perception, status } = await createLeader(screen.source)
    perception.enabled = true
    await expect.poll(() => runner.frames().length, { timeout: 15_000 }).toBeGreaterThan(3)
    expect(runner.events()).toEqual([])

    screen.setScene(1)
    await expect.poll(() => runner.events().length, { timeout: 15_000 }).toBe(1)
    expect(runner.events()[0]).toMatchObject({ type: 'scene-change', familiar: false })
    await expect.poll(() => status.status.events).toHaveLength(1)
  })

  it('captures the target window of a commentary, sees it only in front, and reports its close after the grace time', async () => {
    let window: ForegroundWindow = { id: 1, title: 'Match', app: 'Game' }
    let open = true
    const screen = canvasSource({ foreground: () => window, windowOpen: () => open })
    const { runner, perception, status } = await createLeader(screen.source)
    const closed: string[] = []
    runner.onTargetClosed(app => closed.push(app))
    perception.enabled = true
    await expect.poll(() => status.status.state, { timeout: 15_000 }).toBe('running')

    runner.setTarget('Game')
    await expect.poll(() => screen.source.start).toHaveBeenLastCalledWith({ app: 'Game' })
    await expect.poll(() => runner.frames().length, { timeout: 15_000 }).toBeGreaterThan(0)
    await expect.poll(() => status.status, { timeout: 15_000 }).toMatchObject({ target: 'Game', targetInFront: true })
    expect(runner.targetInView()).toBe(true)

    window = { id: 2, title: 'Notes', app: 'Editor' }
    const before = runner.frames().length
    await expect.poll(() => status.status.targetInFront, { timeout: 15_000 }).toBe(false)
    expect(runner.targetInView()).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 1_200))
    expect(runner.frames().length).toBeLessThanOrEqual(before + 1)

    // A game can open its next window soon, so the target waits for the grace time before it counts as closed.
    open = false
    await expect.poll(() => runner.running(), { timeout: 15_000 }).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 3_500))
    expect(closed).toEqual([])

    // The grace time is 5 minutes. Only the clock moves past it, and the search ticks stay real.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * 60_000 })
    await expect.poll(() => closed, { timeout: 15_000 }).toEqual(['Game'])
  })

  it('moves the capture to another window of the target app that stays in front, and keeps the commentary', async () => {
    let window: ForegroundWindow = { id: 1, title: 'Lobby', app: 'Game' }
    const screen = canvasSource({ foreground: () => window, windowOpen: () => true })
    const { runner, perception, status } = await createLeader(screen.source)
    const closed: string[] = []
    runner.onTargetClosed(app => closed.push(app))
    perception.enabled = true
    await expect.poll(() => status.status.state, { timeout: 15_000 }).toBe('running')
    runner.setTarget('Game')
    await expect.poll(() => runner.targetInView(), { timeout: 15_000 }).toBe(true)

    // The next match opens a new window. Until the capture moves, the frames show the lobby, so they do not count.
    window = { id: 2, title: 'Match', app: 'Game' }
    await new Promise(resolve => setTimeout(resolve, 1_000))
    expect(runner.targetInView()).toBe(false)
    expect(screen.source.start).not.toHaveBeenCalledWith({ app: 'Game', windowId: 2 })

    await expect.poll(() => screen.source.start, { timeout: 15_000 }).toHaveBeenLastCalledWith({ app: 'Game', windowId: 2 })
    await expect.poll(() => runner.targetInView(), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => runner.frames().length, { timeout: 15_000 }).toBeGreaterThan(0)
    expect(screen.source.start).toHaveBeenCalledTimes(3)
    expect(closed).toEqual([])
  })

  it('looks for another window of the target app after its window closes, and captures it', async () => {
    let window: ForegroundWindow = { id: 1, title: 'Match', app: 'Game' }
    let open = true
    const screen = canvasSource({ foreground: () => window, windowOpen: () => open })
    const { runner, perception, status } = await createLeader(screen.source)
    const closed: string[] = []
    runner.onTargetClosed(app => closed.push(app))
    perception.enabled = true
    await expect.poll(() => status.status.state, { timeout: 15_000 }).toBe('running')
    runner.setTarget('Game')
    await expect.poll(() => runner.frames().length, { timeout: 15_000 }).toBeGreaterThan(0)

    // The match ends: its window closes, and the lobby opens a few seconds later.
    open = false
    const [track] = screen.streams.at(-1)!.getVideoTracks()
    track.stop()
    track.dispatchEvent(new Event('ended'))
    await expect.poll(() => runner.running()).toBe(false)
    expect(runner.targetInView()).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 1_000))
    window = { id: 2, title: 'Lobby', app: 'Game' }
    open = true

    await expect.poll(() => runner.frames().length, { timeout: 15_000 }).toBeGreaterThan(0)
    expect(runner.targetInView()).toBe(true)
    expect(screen.source.start).toHaveBeenLastCalledWith({ app: 'Game' })
    expect(screen.source.start).toHaveLastResolvedWith({ stream: screen.streams.at(-1), windowId: 2 })
    expect(closed).toEqual([])
  })

  it('gives screen frames for a sidecar only during a commentary, while the watched window is in view', async () => {
    let window: ForegroundWindow = { title: 'Match', app: 'Game' }
    const screen = canvasSource({ foreground: () => window })
    const { runner, perception, status } = await createLeader(screen.source)
    const images: Blob[] = []
    const stop = runner.onScreenFrame(image => images.push(image))
    perception.enabled = true
    await expect.poll(() => runner.frames().length, { timeout: 15_000 }).toBeGreaterThan(0)
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(images).toHaveLength(0)

    runner.setTarget('Game')
    await expect.poll(() => images.length, { timeout: 15_000 }).toBeGreaterThan(3)
    expect(images[0].type).toBe('image/jpeg')
    const bitmap = await createImageBitmap(images[0])
    expect(Math.max(bitmap.width, bitmap.height)).toBeLessThanOrEqual(SCREEN_FRAME_LIMITS.maxLongSide)
    bitmap.close()

    // The frames come more often than the frames of the ring.
    await expect.poll(() => images.length - runner.frames().length, { timeout: 15_000 }).toBeGreaterThan(3)

    window = { title: 'Vault', app: 'Bitwarden' }
    await expect.poll(() => status.status.excludedNow, { timeout: 15_000 }).toBe(true)
    const excludedAt = images.length
    await new Promise(resolve => setTimeout(resolve, 800))
    expect(images.length).toBeLessThanOrEqual(excludedAt + 1)

    window = { title: 'Match', app: 'Game' }
    await expect.poll(() => images.length, { timeout: 15_000 }).toBeGreaterThan(excludedAt + 2)

    stop()
    const stoppedAt = images.length
    await new Promise(resolve => setTimeout(resolve, 800))
    expect(images.length).toBeLessThanOrEqual(stoppedAt + 1)
  })

  it('records the frames of the ring and owner messages while asked, skips excluded frames, and stops on a pause', async () => {
    let window: ForegroundWindow = { title: 'Match', app: 'Game' }
    const screen = canvasSource({ foreground: () => window })
    const frames: RecorderFrame[] = []
    const events: RecorderEvent[] = []
    const recorder: PerceptionRecorderSink = {
      start: vi.fn(async () => ({ id: 'rec-1', startedAt: Date.now(), frames: 0, bytes: 0, recording: true })),
      appendFrame: vi.fn(async (_id: string, frame: RecorderFrame) => {
        frames.push(frame)
        return {}
      }),
      appendEvents: vi.fn(async (_id: string, added: RecorderEvent[]) => {
        events.push(...added)
      }),
      stop: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      remove: vi.fn(async () => true),
      openFolder: vi.fn(async () => {}),
    }
    const { runner, perception, status } = await createLeader(screen.source, recorder)
    perception.enabled = true
    await expect.poll(() => status.status.state, { timeout: 15_000 }).toBe('running')
    expect(status.status.canRecord).toBe(true)

    status.requestRecording(true)
    await expect.poll(() => frames.length, { timeout: 15_000 }).toBeGreaterThan(1)
    expect(frames[0]).toMatchObject({ app: 'Game', thumbnail: expect.any(String) })
    expect(frames[0].image.byteLength).toBeGreaterThan(0)
    runner.recordOwnerMessage(1_234)
    await expect.poll(() => events).toContainEqual({ kind: 'owner-message', at: 1_234 })

    window = { title: 'Vault', app: 'Bitwarden' }
    await expect.poll(() => status.status.excludedNow, { timeout: 15_000 }).toBe(true)
    const recorded = frames.length
    await new Promise(resolve => setTimeout(resolve, 1_200))
    expect(frames.length).toBeLessThanOrEqual(recorded + 1)
    expect(frames.every(frame => frame.app !== 'Bitwarden')).toBe(true)

    perception.paused = true
    await expect.poll(() => recorder.stop).toHaveBeenCalled()
    expect(status.recordingWanted).toBe(false)
  })
})
