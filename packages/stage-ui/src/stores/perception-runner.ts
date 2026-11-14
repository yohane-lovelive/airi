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
import { FRAME_LIMITS, FrameRing, SCREEN_FRAME_LIMITS } from '../libs/perception/frame-ring'
import { windowOfApp } from '../libs/perception/screen-source'
import { FrameEncoder } from '../workers/frame-encoder'
import { Ticker } from '../workers/ticker'
import { usePerceptionStore } from './perception'
import { usePerceptionStatusStore } from './perception-status'

/** The status goes to other windows at most this often. A frame comes twice as often. */
const PUBLISH_INTERVAL_MS = 1_000
/** The status keeps this many recent screen events for the inspector. */
const RECENT_EVENT_COUNT = 20
/**
 * How a commentary keeps the window of its app. A game can open a new window for each match, and it can show its lobby
 * in another window between matches. A live check on 2026-11-12 with League of Legends found a commentary that ended
 * with its first match, so the capture now follows the windows of the app.
 */
const TARGET_WINDOW_LIMITS = {
  /** While a target window is set, the runner checks this often that a window of the app is still open. */
  checkIntervalMs: 5_000,
  /** Another window of the app must stay in front this long, and the capture then moves to it. */
  followHoldMs: 2_000,
  /** After the window closed, the runner looks for another window of the app this often. */
  searchIntervalMs: 3_000,
  /**
   * After the window closed, the runner looks this long. Only then the target counts as closed. A live check on
   * 2026-11-13 found no lobby window of League of Legends 2 minutes after a match, so 60 seconds was too short.
   */
  lostGraceMs: 5 * 60_000,
}

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
 * - A commentary sets a target app. The desktop then captures one window of that app, and it takes frames only while
 *   that window is in front. Another window of the app that stays in front for 2 seconds takes the capture. When the
 *   window closes, the runner looks for another window of the app for 5 minutes. Only then the target-closed
 *   listeners hear it.
 * - The decision turn of the initiative runner reads the frames and the events.
 * - While the owner asks for it, the desktop app records each frame of the ring, the screen events, and the owner
 *   messages to the disk for replay evaluation. Excluded frames are not recorded, and a stop of the capture stops it.
 * - While a listener of the screen frames waits and a commentary watches its window, a second ticker takes 8 smaller
 *   frames each second for the screen of a sidecar room. It takes them only while the last tick saw the window in view,
 *   so the rules of the ring hold. These frames stay out of the ring and out of a recording.
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
  const screenTicker = new Ticker(SCREEN_FRAME_LIMITS.intervalMs, () => void sampleScreen())
  const screenListeners = new Set<(image: Blob) => void>()
  let screenSampling = false
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
  /** Whether the captured window of the target app was in front at the last tick. */
  let targetInFront = false
  let lastTargetCheckAt = 0
  /** The handle of the captured window of the target, where the source tells it. */
  let capturedWindowId: number | undefined
  /** Another window of the target app in front, and since when. The capture moves to it after the hold time. */
  let otherInFront: { id: number, since: number } | undefined
  /** Since when no window of the target is captured, after its window closed. Undefined while one is captured. */
  let lostSince: number | undefined
  let searching = false
  const searchTicker = new Ticker(TARGET_WINDOW_LIMITS.searchIntervalMs, () => void search())
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
    screenTicker.stop()
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
    capturedWindowId = undefined
    otherInFront = undefined
  }

  /** Tells the listeners that the window of the target closed. */
  function closeTarget(app: string) {
    for (const listener of targetClosedListeners)
      listener(app)
  }

  /**
   * Starts the capture: the display, or one window of the target app.
   *
   * @param windowId The window of the target app to capture. Without it, the source takes the front window of the app.
   */
  async function start(windowId?: number) {
    if (!source || starting || stream)
      return
    starting = true
    publish(true)
    try {
      const watched = target
      const next = await source.start(watched ? { app: watched, ...(windowId !== undefined ? { windowId } : {}) } : undefined)
      if (!wanted() || target !== watched) {
        for (const track of next.stream.getTracks())
          track.stop()
        // A new target came during the start, so the capture starts again for it.
        if (target !== watched)
          queueMicrotask(sync)
        return
      }
      const element = document.createElement('video')
      element.muted = true
      element.srcObject = next.stream
      // `play` resolves only after the first frame, and a still screen can be slow to send one. Each tick checks that
      // the video has a frame, so the start does not wait here.
      element.play().catch(error => console.warn('[perception] Failed to play the capture:', errorMessageFrom(error)))
      for (const track of next.stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (stream !== next.stream)
            return
          // The window of a commentary closed. A game can open its next window soon, so the runner looks for one.
          if (watched) {
            loseTarget()
            return
          }
          ended = true
          stopCapture()
          if (statusStore.recordingWanted)
            statusStore.requestRecording(false)
          publish(true)
        }, { once: true })
      }
      stream = next.stream
      video = element
      capturedWindowId = next.windowId
      excluded = 0
      ticker.start()
      syncScreenTicker()
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
    // While the window of the target is lost, only the search starts the capture again.
    if (!stream && !ended && !failure && lostSince === undefined && !source?.needsGesture)
      void start()
    publish(true)
  }

  /**
   * The window of the target closed. The capture stops, and the runner looks for another window of the app until the
   * grace time ends. A source that cannot list the windows, for example the web, ends the target at once.
   */
  function loseTarget() {
    const lost = target
    stopCapture()
    if (!lost)
      return
    if (!source?.windowOpen) {
      closeTarget(lost)
      return
    }
    lostSince = Date.now()
    console.info(`[perception] The window of ${lost} closed. The capture looks for another window of it for ${TARGET_WINDOW_LIMITS.lostGraceMs / 60_000} min.`)
    searchTicker.start()
    publish(true)
  }

  /** Looks for a window of the lost target. A found window takes the capture, and the end of the grace time ends the target. */
  async function search() {
    if (searching || !target || lostSince === undefined || !source?.windowOpen || !wanted())
      return
    searching = true
    try {
      const lost = target
      const open = await source.windowOpen(lost)
      if (target !== lost || lostSince === undefined)
        return
      if (open) {
        console.info(`[perception] Another window of ${lost} is open after ${Math.round((Date.now() - lostSince) / 1_000)} s, so the capture takes it.`)
        stopSearch()
        await start()
        return
      }
      if (Date.now() - lostSince >= TARGET_WINDOW_LIMITS.lostGraceMs) {
        stopSearch()
        closeTarget(lost)
      }
    }
    catch (error) {
      console.warn('[perception] Failed to look for the window of the target:', errorMessageFrom(error))
    }
    finally {
      searching = false
    }
  }

  function stopSearch() {
    searchTicker.stop()
    lostSince = undefined
  }

  /** Moves the capture to another window of the target app. The commentary goes on. */
  function follow(windowId: number) {
    console.info(`[perception] Another window of ${target} stayed in front, so the capture moves to it.`)
    stopCapture()
    void start(windowId)
  }

  /** Takes one frame, unless the window in front matches the exclusion list. */
  async function sample() {
    if (sampling || !stream || !video || !source)
      return
    sampling = true
    try {
      const at = Date.now()
      if (target && source.windowOpen && at - lastTargetCheckAt >= TARGET_WINDOW_LIMITS.checkIntervalMs) {
        lastTargetCheckAt = at
        if (!await source.windowOpen(target)) {
          loseTarget()
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
        // A commentary sees its window only while the owner has it in front, as the ADR asks. Another window of the app,
        // for example the next match of a game, is not the captured window. Until the capture moves, frames show the old one.
        const appInFront = Boolean(target && window && windowOfApp(window, target))
        const otherId = appInFront && window?.id !== undefined && capturedWindowId !== undefined && window.id !== capturedWindowId ? window.id : undefined
        targetInFront = appInFront && otherId === undefined
        if (otherId === undefined) {
          otherInFront = undefined
        }
        else if (otherInFront?.id !== otherId) {
          otherInFront = { id: otherId, since: at }
        }
        else if (at - otherInFront.since >= TARGET_WINDOW_LIMITS.followHoldMs) {
          follow(otherId)
          return
        }
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

  /** Whether the watched window is in view now, as {@link targetInView} tells the other stores. */
  function inView() {
    return Boolean(stream) && !excludedNow && (!source?.foreground || targetInFront)
  }

  /** Runs the screen ticker while a listener waits and a commentary watches its window. */
  function syncScreenTicker() {
    if (screenListeners.size && stream && target)
      screenTicker.start()
    else
      screenTicker.stop()
  }

  /**
   * Takes one frame for the screen of a sidecar room. The tick of the ring checks the window in front, so this frame
   * comes only while that check saw the watched window in view. One frame is in work at a time.
   */
  async function sampleScreen() {
    if (screenSampling || !target || !video || !inView() || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)
      return
    screenSampling = true
    try {
      const image = await encoder.encodeScreen(await createImageBitmap(video))
      // A pause, a lock, or the end of the commentary during the encode drops the frame.
      if (!stream || !target)
        return
      for (const listener of screenListeners)
        listener(image)
    }
    catch (error) {
      console.warn('[perception] Failed to take a screen frame:', errorMessageFrom(error))
    }
    finally {
      screenSampling = false
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
    stopSearch()
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
    stopSearch()
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
    /**
     * Whether frames of the watched window come in now. Capture must run, and the window in front must not be excluded.
     * A device that cannot tell the window in front captures only what the owner shared, so that counts as in view.
     */
    targetInView: inView,
    /**
     * Calls the listener with each frame for the screen of a sidecar room, 8 each second, while a commentary watches
     * its window and the window is in view. Returns a function that removes it.
     */
    onScreenFrame: (listener: (image: Blob) => void) => {
      screenListeners.add(listener)
      syncScreenTicker()
      return () => {
        screenListeners.delete(listener)
        syncScreenTicker()
      }
    },
    /** Calls the listener with each batch of new screen events. Returns a function that removes it. */
    onEvents: (listener: (events: readonly ScreenEvent[]) => void) => {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    /**
     * Calls the listener when no window of the target app is open, 5 minutes after its window closed. Returns a
     * function that removes it.
     */
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
