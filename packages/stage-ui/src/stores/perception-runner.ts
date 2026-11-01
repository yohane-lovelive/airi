import type { ScreenEvent } from '@proj-airi/stage-shared/perception'
import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import type { PerceptionRecorderSink, RecorderEvent } from '../libs/perception/recorder'
import type { ScreenSource } from '../libs/perception/screen-source'
import type { PerceptionState } from './perception-status'

import { errorMessageFrom } from '@moeru/std'
import { encodeBase64 } from '@moeru/std/base64'
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
/** While a target window is set, the runner checks this often that the window is still open. */
const TARGET_CHECK_INTERVAL_MS = 5_000

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
 * - A commentary sets a target app. The desktop then captures the front window of that app only, and it takes frames
 *   only while that app is in front. When the window closes, the target-closed listeners hear it.
 * - The decision turn of the initiative runner reads the frames and the events.
 * - While the owner asks for it, the desktop app records each frame of the ring, the screen events, and the owner
 *   messages to the disk for replay evaluation. Excluded frames are not recorded, and a stop of the capture stops it.
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
  const eventListeners = new Set<(events: readonly ScreenEvent[]) => void>()
  /** The app whose window a commentary watches. Undefined captures the whole display. */
  let target: string | undefined
  /** Whether the target app was in front at the last tick. */
  let targetInFront = false
  let lastTargetCheckAt = 0
  const targetClosedListeners = new Set<(app: string) => void>()
  let recorder: PerceptionRecorderSink | undefined
  /** The recording that runs now. Writes go one after another, so the frames stay in order. */
  let recording: { id: string, startedAt: number, frames: number } | undefined
  let recordingStarting = false
  let recordQueue: Promise<void> = Promise.resolve()

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
      ...(target ? { target, targetInFront } : {}),
      ...(recording ? { recording: { ...recording } } : {}),
      canRecord: Boolean(recorder),
      activity: stream ? detector.activity : 0,
      events: recentEvents,
      ...(foregroundApp ? { foregroundApp } : {}),
      ...(failure ? { error: failure } : {}),
      updatedAt: now,
    })
  }

  /** Queues one write of the recording. A failure only logs, so the capture goes on. */
  function record(write: (id: string) => Promise<void>) {
    const id = recording?.id
    if (!id || !recorder)
      return
    recordQueue = recordQueue.then(() => write(id)).catch(error => console.warn('[perception] Failed to write the recording:', errorMessageFrom(error)))
  }

  /** Starts or stops the recording to match the owner's request and the capture. */
  function syncRecording() {
    if (!recorder || !isLeader())
      return
    const wanted = statusStore.recordingWanted && Boolean(stream)
    if (wanted && !recording && !recordingStarting) {
      recordingStarting = true
      void recorder.start().then((info) => {
        recording = { id: info.id, startedAt: info.startedAt, frames: 0 }
      }).catch((error) => {
        console.warn('[perception] Failed to start the recording:', errorMessageFrom(error))
        statusStore.requestRecording(false)
      }).finally(() => {
        recordingStarting = false
        publish(true)
      })
    }
    else if (!wanted && recording) {
      const sink = recorder
      recording = undefined
      recordQueue = recordQueue.then(async () => {
        await sink.stop()
      }).catch(error => console.warn('[perception] Failed to stop the recording:', errorMessageFrom(error)))
      publish(true)
    }
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
    targetInFront = false
  }

  /** Tells the listeners that the window of the target closed. */
  function closeTarget(app: string) {
    for (const listener of targetClosedListeners)
      listener(app)
  }

  async function start() {
    if (!source || starting || stream)
      return
    starting = true
    publish(true)
    try {
      const watched = target
      const next = await source.start(watched ? { app: watched } : undefined)
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
          // The window of a commentary closed. The commentary ends, and the display capture comes back.
          if (watched) {
            stopCapture()
            closeTarget(watched)
            return
          }
          ended = true
          stopCapture()
          if (statusStore.recordingWanted)
            statusStore.requestRecording(false)
          publish(true)
        }, { once: true })
      }
      stream = next
      video = element
      excluded = 0
      ticker.start()
      syncRecording()
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
      // A pause, a lock, or a leader change also ends the recording. A new target only restarts the capture.
      if (statusStore.recordingWanted && isLeader())
        statusStore.requestRecording(false)
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
      if (target && source.windowOpen && at - lastTargetCheckAt >= TARGET_CHECK_INTERVAL_MS) {
        lastTargetCheckAt = at
        if (!await source.windowOpen(target)) {
          const closed = target
          stopCapture()
          closeTarget(closed)
          return
        }
      }
      if (source.foreground) {
        const window = await source.foreground()
        foregroundApp = window?.app
        excludedNow = Boolean(window && exclusionMatch(window, perception.exclusions))
        if (excludedNow) {
          excluded += 1
          detector.skip(at)
          return
        }
        // A commentary sees its window only while the owner has it in front, as the ADR asks.
        targetInFront = Boolean(target && window && window.app.toLowerCase().includes(target.toLowerCase()))
        if (target && !targetInFront) {
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
      if (recording) {
        recording.frames += 1
        const app = foregroundApp
        record(async (id) => {
          const result = await recorder!.appendFrame(id, { at, image: new Uint8Array(await frame.image.arrayBuffer()), thumbnail: encodeBase64(frame.thumbnail), ...(app ? { app } : {}) })
          // The main process stops a recording at its time or size limit.
          if (result.stopped && recording?.id === id) {
            recording = undefined
            statusStore.requestRecording(false)
            publish(true)
          }
        })
      }
      const events = detector.observe({ at, thumbnail: frame.thumbnail, ...(foregroundApp ? { app: foregroundApp } : {}) })
      if (events.length) {
        recordEvents(events.map(event => ({ kind: 'screen', at: event.at, type: event.type, salience: event.salience, ...(event.app ? { app: event.app } : {}) })))
        recentEvents = [...recentEvents, ...events].slice(-RECENT_EVENT_COUNT)
        publish(true)
        for (const listener of eventListeners)
          listener(events)
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

  watch(() => statusStore.recordingWanted, () => syncRecording())

  watch(() => statusStore.startRequestedAt, () => {
    if (isLeader())
      void startFromGesture()
  })

  function recordEvents(events: RecorderEvent[]) {
    if (events.length)
      record(id => recorder!.appendEvents(id, events))
  }

  /**
   * Sets the app whose window a commentary watches, or clears it. The capture starts again for the new target.
   * Each window can call it, and only the leader captures.
   */
  function setTarget(app: string | undefined) {
    const next = app?.trim() || undefined
    if (next === target)
      return
    target = next
    lastTargetCheckAt = Date.now()
    ended = false
    failure = undefined
    if (stream || video)
      stopCapture()
    sync()
  }

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
   * @param recorderSink Where the screen recorder writes. Only the desktop app has one.
   */
  function initialize(syncedPinia: SyncedPiniaRuntime, screenSource?: ScreenSource, recorderSink?: PerceptionRecorderSink) {
    if (leadership)
      return
    leadership = syncedPinia
    source = screenSource
    recorder = recorderSink
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
    /** Whether frames come in on this renderer now. */
    running: () => Boolean(stream),
    /** The app in front at the last frame, where the device can tell it. */
    foregroundApp: () => foregroundApp,
    /** Whether the last frame was skipped, because the window in front is excluded. */
    excludedNow: () => excludedNow,
    /** Calls the listener with each batch of new screen events. Returns a function that removes it. */
    onEvents: (listener: (events: readonly ScreenEvent[]) => void) => {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    /** Calls the listener when the window of the target app closes. Returns a function that removes it. */
    onTargetClosed: (listener: (app: string) => void) => {
      targetClosedListeners.add(listener)
      return () => targetClosedListeners.delete(listener)
    },
    /** The activity level of the screen now, from 0 to 1. */
    activity: () => (stream ? detector.activity : 0),
    setTarget,
    /** Notes an owner message in the recording that runs now. The text stays out. */
    recordOwnerMessage: (at: number) => recordEvents([{ kind: 'owner-message', at }]),
    /** The recordings on the device, and their actions. Undefined in an app that cannot record. */
    recorder: () => recorder,
    startFromGesture,
    initialize,
    dispose,
  }
})
