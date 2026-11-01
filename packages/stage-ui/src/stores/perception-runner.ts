import type { ScreenEvent } from '@proj-airi/stage-shared/perception'
import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import type { ScreenSource } from '../libs/perception/screen-source'
import type { PerceptionState } from './perception-status'

import { errorMessageFrom } from '@moeru/std'
import { ScreenDetector } from '@proj-airi/stage-shared/perception'
import { defineStore } from 'pinia'
import { onScopeDispose, watch } from 'vue'

import { exclusionMatch } from '../libs/perception/exclusion'
import { FRAME_LIMITS, FrameRing } from '../libs/perception/frame-ring'
import { FrameEncoder } from '../workers/frame-encoder'
import { Ticker } from '../workers/ticker'
import { usePerceptionStore } from './perception'
import { usePerceptionStatusStore } from './perception-status'

/** The status goes to other windows at most this often. A frame comes twice as often. */
const PUBLISH_INTERVAL_MS = 1_000
/** The status keeps this many recent screen events for the inspector. */
const RECENT_EVENT_COUNT = 20

/**
 * Captures the screen on the renderer leader and keeps the frames of the last minute in memory.
 *
 * State model:
 * - The settings store says whether to capture. This store keeps runtime state only: the stream, the frame ring, and
 *   the counts. Nothing reaches the disk. A pause, a lock, or a leader change stops the capture and drops the frames.
 * - Each tick takes one frame, twice a second. Where the source knows the window in front, a window that matches the
 *   exclusion list is skipped before the frame is taken.
 * - The desktop app starts the capture by itself. The web app needs a click of the owner, so it waits in `needs-share`.
 * - When the shared screen or window goes away, the capture ends, and the owner starts it again.
 * - The screen detectors read each frame and its app in front. They give screen events and an activity level. A skipped
 *   frame makes them settle again, so the change around an excluded window is no event.
 * - Frames and events do not reach the model yet. The decision turn reads them in a later step of the ADR.
 *
 * Use when:
 * - An app starts its renderer. Call `initialize` once with the synced Pinia runtime and the screen source of the app.
 */
export const usePerceptionRunnerStore = defineStore('perception-runner', () => {
  const perception = usePerceptionStore()
  const statusStore = usePerceptionStatusStore()

  const ring = new FrameRing()
  const encoder = new FrameEncoder()
  const ticker = new Ticker(FRAME_LIMITS.intervalMs, () => void sample())
  let leadership: SyncedPiniaRuntime | undefined
  let source: ScreenSource | undefined
  let stopLeadershipListener: (() => void) | undefined
  let stopInterruptListener: (() => void) | undefined

  let stream: MediaStream | undefined
  let video: HTMLVideoElement | undefined
  let starting = false
  let sampling = false
  /** The screen is locked, or the device sleeps. */
  let interrupted = false
  /** The shared screen or window went away. The owner starts again. */
  let ended = false
  let failure: string | undefined
  let excluded = 0
  let excludedNow = false
  let foregroundApp: string | undefined
  let lastPublished: { state: PerceptionState, at: number } | undefined
  let detector = createDetector()
  let recentEvents: ScreenEvent[] = []

  function createDetector() {
    return new ScreenDetector({ width: FRAME_LIMITS.thumbnailWidth, height: FRAME_LIMITS.thumbnailHeight })
  }

  function isLeader() {
    return Boolean(leadership?.isLeader())
  }

  /** Whether this renderer must capture now. */
  function wanted() {
    return isLeader() && Boolean(source?.supported) && perception.enabled && !perception.paused && !interrupted
  }

  function stateNow(): PerceptionState {
    if (!perception.enabled)
      return 'off'
    if (perception.paused)
      return 'paused'
    if (interrupted)
      return 'interrupted'
    if (failure)
      return 'failed'
    if (ended)
      return 'ended'
    if (stream)
      return 'running'
    if (starting || !source?.needsGesture)
      return 'starting'
    return 'needs-share'
  }

  /** Reports the status to every window. A change of state goes at once, and counts at most once each second. */
  function publish(force = false) {
    if (!isLeader())
      return
    const now = Date.now()
    const state = stateNow()
    if (!force && lastPublished?.state === state && now - lastPublished.at < PUBLISH_INTERVAL_MS)
      return
    lastPublished = { state, at: now }
    statusStore.report({
      state,
      frames: ring.size,
      bytes: ring.bytes,
      excluded,
      excludedNow,
      knowsForeground: Boolean(source?.foreground),
      activity: stream ? detector.activity : 0,
      events: recentEvents,
      ...(foregroundApp ? { foregroundApp } : {}),
      ...(failure ? { error: failure } : {}),
      updatedAt: now,
    })
  }

  function stopCapture() {
    ticker.stop()
    for (const track of stream?.getTracks() ?? [])
      track.stop()
    stream = undefined
    if (video) {
      video.pause()
      video.srcObject = null
    }
    video = undefined
    ring.clear()
    detector = createDetector()
    excludedNow = false
    foregroundApp = undefined
  }

  async function start() {
    if (!source || starting || stream)
      return
    starting = true
    publish(true)
    try {
      const next = await source.start()
      if (!wanted()) {
        for (const track of next.getTracks())
          track.stop()
        return
      }
      const element = document.createElement('video')
      element.muted = true
      element.srcObject = next
      // `play` resolves only after the first frame, and a still screen can be slow to send one. Each tick checks that
      // the video has a frame, so the start does not wait here.
      element.play().catch(error => console.warn('[perception] Failed to play the capture:', errorMessageFrom(error)))
      for (const track of next.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (stream !== next)
            return
          ended = true
          stopCapture()
          publish(true)
        }, { once: true })
      }
      stream = next
      video = element
      excluded = 0
      ticker.start()
    }
    catch (error) {
      failure = errorMessageFrom(error) ?? 'The capture did not start.'
      console.warn('[perception] Failed to start the capture:', failure)
    }
    finally {
      starting = false
      publish(true)
    }
  }

  /** Starts or stops the capture to match the settings, the leadership, and the device state. */
  function sync() {
    if (!wanted()) {
      if (stream || video)
        stopCapture()
      publish(true)
      return
    }
    if (!stream && !ended && !failure && !source?.needsGesture)
      void start()
    publish(true)
  }

  /** Takes one frame, unless the window in front matches the exclusion list. */
  async function sample() {
    if (sampling || !stream || !video || !source)
      return
    sampling = true
    try {
      const at = Date.now()
      if (source.foreground) {
        const window = await source.foreground()
        foregroundApp = window?.app
        excludedNow = Boolean(window && exclusionMatch(window, perception.exclusions))
        if (excludedNow) {
          excluded += 1
          detector.skip(at)
          return
        }
      }
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)
        return
      const bitmap = await createImageBitmap(video)
      const frame = await encoder.encode(bitmap, at)
      // A pause or a lock during the encode dropped the ring, so its frame must not come back.
      if (!stream)
        return
      ring.push(frame)
      const events = detector.observe({ at, thumbnail: frame.thumbnail, ...(foregroundApp ? { app: foregroundApp } : {}) })
      if (events.length) {
        recentEvents = [...recentEvents, ...events].slice(-RECENT_EVENT_COUNT)
        publish(true)
      }
    }
    catch (error) {
      console.warn('[perception] Failed to take a frame:', errorMessageFrom(error))
    }
    finally {
      sampling = false
      publish()
    }
  }

  /**
   * Starts the capture from a click of the owner. The web app needs it for each page load. It also starts the capture
   * again after the shared screen went away or a start failed. A window that does not lead asks the leader.
   */
  async function startFromGesture() {
    if (!isLeader()) {
      statusStore.requestStart()
      return
    }
    ended = false
    failure = undefined
    if (wanted())
      await start()
    else
      publish(true)
  }

  watch(() => statusStore.startRequestedAt, () => {
    if (isLeader())
      void startFromGesture()
  })

  // Turning perception on, or a pause and a resume, is a new start, so an earlier end or failure no longer holds.
  watch(() => [perception.enabled, perception.paused] as const, () => {
    ended = false
    failure = undefined
    sync()
  })

  /**
   * Starts perception on this renderer while it leads. Later calls do nothing.
   *
   * @param syncedPinia The synced Pinia runtime. Only its leader captures.
   * @param screenSource Where the app captures the screen. Without it, perception does not run in this app.
   */
  function initialize(syncedPinia: SyncedPiniaRuntime, screenSource?: ScreenSource) {
    if (leadership)
      return
    leadership = syncedPinia
    source = screenSource
    perception.supported = Boolean(screenSource?.supported)
    stopInterruptListener = screenSource?.onInterrupt?.((value) => {
      interrupted = value
      sync()
    })
    stopLeadershipListener = syncedPinia.onLeadershipChange(() => sync())
    sync()
  }

  function dispose() {
    stopLeadershipListener?.()
    stopLeadershipListener = undefined
    stopInterruptListener?.()
    stopInterruptListener = undefined
    stopCapture()
    encoder.dispose()
    leadership = undefined
    source = undefined
  }

  onScopeDispose(dispose)

  return {
    /** The frames of the last minute, oldest first. Empty on a renderer that does not capture. */
    frames: () => ring.frames(),
    /** The recent screen events, newest last. */
    events: () => recentEvents,
    startFromGesture,
    initialize,
    dispose,
  }
})
