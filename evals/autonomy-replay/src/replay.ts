import type { InitiativeMode, InitiativeOptions, InitiativeScreenContext, InitiativeTrigger, SpeechType, Timeline } from '@proj-airi/core-agent'
import type { FramePolicyName, ScreenEvent } from '@proj-airi/stage-shared/perception'

import type { RecordedFrame, Recording } from './recording'

import {
  addTimelineNotes,
  commentaryIntervalFactor,
  createInitiativeState,
  decideInitiative,
  drawLineLength,
  EMPTY_TIMELINE,
  initiativeEndMarker,
  initiativeNoticeText,
  initiativeTimeFrom,
  nextFromMarker,
  observeInitiative,
  resolveInitiativeOptions,
  setTimelineCast,
  setTimelineScene,
  timelineMarkerFrom,
} from '@proj-airi/core-agent'
import { pickContactSheet, pickFreshKeyframes, pickRecentSheet, sceneAnchorAt, ScreenDetector } from '@proj-airi/stage-shared/perception'

/** Settings of one replay. */
export interface ReplayOptions {
  readonly mode: InitiativeMode
  readonly policy: FramePolicyName
  /** The seed of the random source, so two runs of one recording make the same decisions until the replies differ. */
  readonly seed: number
  /** The most frames for one turn. The app sends three, or two in commentary. */
  readonly maxImagesPerTurn?: number
  /**
   * The cast of the scene from the start of the replay: who the owner plays, the allies, and the opponents.
   * A recording can start after the screen that shows the names, so a replay can give them. See `loadCast`.
   */
  readonly cast?: string
}

/** The tokens of one model call, as the provider reported them. */
export interface TokenUsage {
  readonly input: number
  readonly output: number
  /** Input tokens that the provider read from its cache. */
  readonly cached: number
}

/** One decision turn that the replay sends to the speaking model. */
export interface ReplayTurn {
  readonly at: number
  readonly trigger: InitiativeTrigger
  readonly speechType?: SpeechType
  readonly notice: string
  /** The marker that ends the reply, as the notice asks for it. The chat runtime drops what the model writes after it. */
  readonly endMarker: 'NEXT' | 'TOPIC'
  /** The frames that go one by one, oldest first. The last one goes at full size. */
  readonly frames: readonly RecordedFrame[]
  /** The frames that go as the tiles of one contact sheet, oldest first. */
  readonly sheet?: readonly RecordedFrame[]
  /** The anchor frame of the current scene, which goes near the start of the request. */
  readonly anchor?: RecordedFrame
}

/** What the speaking model answered for one turn. */
export interface SpokenReply {
  readonly text: string
  readonly usage?: TokenUsage
  /** The time from the start of the request to the first text, in milliseconds. A reply without text has none. */
  readonly firstTextMs?: number
  /** The time of the whole turn, with its tool rounds, in milliseconds. */
  readonly durationMs?: number
  /** The model requests of the turn. A turn with a tool call has more than one. */
  readonly requests?: number
  readonly toolCalls?: number
  /** The model wrote on after the end marker of its reply, and the chat runtime dropped that text. */
  readonly cut?: boolean
}

/** One line that the character spoke in the replay. */
export interface ReplayLine {
  readonly at: number
  readonly text: string
  readonly trigger: InitiativeTrigger
  readonly speechType?: SpeechType
  /** The frames that the turn showed, oldest first: the single frames or the tiles of the contact sheet. */
  readonly frames: readonly RecordedFrame[]
  /** The time until the owner hears the start of the line, without the speech synthesis. */
  readonly firstTextMs?: number
}

export interface ReplayResult {
  readonly durationMs: number
  readonly turns: number
  readonly silent: number
  readonly images: number
  /** The model requests of all turns. More requests than turns means tool calls. */
  readonly requests: number
  readonly toolCalls: number
  /** The turns where the model wrote on after the end marker of its reply. The chat runtime dropped that text. */
  readonly cuts: number
  /** The lines without an end marker. Nothing can cut what the model writes after such a line. */
  readonly missingEnd: number
  readonly usage: TokenUsage
  readonly lines: readonly ReplayLine[]
  readonly events: readonly ScreenEvent[]
  readonly timeline: Timeline
}

/** The ring of the app holds the frames of this time. A turn picks its frames from them. */
const RING_MS = 60_000
/** A spoken line plays for about this long for each character, so no turn starts while it plays. */
const SPEECH_MS_PER_CHARACTER = 120
const MARKER = /<\|[^|]*\|>/g

/** A small seeded random source (mulberry32), so a replay can run again with the same draws. */
export function seededRandom(seed: number) {
  let value = seed >>> 0
  return () => {
    value = (value + 0x6D2B79F5) >>> 0
    let mixed = value
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * Splits a reply into the spoken text and its timeline markers, as the orchestrator of the app does. Other markers, for
 * example expressions and topic labels, only drop out.
 */
export function splitReply(text: string) {
  const markers = [...text.matchAll(MARKER)].map(match => timelineMarkerFrom(match[0])).filter(marker => marker !== undefined)
  return { spoken: text.replace(MARKER, '').replace(/\s+/g, ' ').trim(), markers }
}

function optionsFor(mode: InitiativeMode, activity: number): InitiativeOptions {
  const options = resolveInitiativeOptions()
  if (mode !== 'commentary')
    return options
  const commentary = options.modes.commentary
  return { ...options, modes: { ...options.modes, commentary: { ...commentary, boredomIntervalMs: commentary.boredomIntervalMs * commentaryIntervalFactor(activity) } } }
}

/**
 * Replays one recording through the detectors, the initiative policy, and a frame policy, with the clock of the
 * recording. Each decision turn goes to `speak`, which calls the model in an evaluation and a fake in a test.
 *
 * - The detectors read the recorded thumbnails, so the events come again as the app made them.
 * - The frame policy picks the frames as the app does. A contact sheet and the scene anchor each count as one image.
 * - The owner messages of the recording reach the policy at their times. Their text was never recorded.
 * - A spoken line holds further turns for its estimated playback time.
 * - The timeline takes the NOTE, SCENE, and CAST markers of the replies, and each later notice gives it to the model.
 */
export async function replayRecording(recording: Recording, options: ReplayOptions, speak: (turn: ReplayTurn) => Promise<SpokenReply>): Promise<ReplayResult> {
  const random = seededRandom(options.seed)
  const detector = new ScreenDetector({ width: 64, height: 36 })
  const maxImages = options.maxImagesPerTurn ?? (options.mode === 'commentary' ? 2 : 3)
  const firstAt = recording.frames[0]?.at ?? recording.startedAt
  let state = createInitiativeState(initiativeTimeFrom(new Date(firstAt)), options.mode)
  let timeline: Timeline = options.cast ? setTimelineCast(EMPTY_TIMELINE, options.cast, firstAt) : EMPTY_TIMELINE
  const events: ScreenEvent[] = []
  const lines: ReplayLine[] = []
  const usage = { input: 0, output: 0, cached: 0 }
  let turns = 0
  let silent = 0
  let images = 0
  let requests = 0
  let toolCalls = 0
  let cuts = 0
  let missingEnd = 0
  let speakingUntil = 0
  /** The end of the last spoken line, until the policy hears of it. */
  let speechEnd: number | undefined
  let lastTurnAt: number | undefined
  let lastOwnerAt: number | undefined
  let ownerIndex = 0
  let anchorFrame: RecordedFrame | undefined
  const withSheet = options.policy === 'contact-sheet' || options.policy === 'scene-anchor+contact-sheet'
  const withAnchor = (options.policy === 'scene-anchor' || options.policy === 'scene-anchor+contact-sheet') && maxImages >= 2
  const withRecentSheet = options.policy === 'recent-sheet' && maxImages >= 2

  for (const [index, frame] of recording.frames.entries()) {
    const time = initiativeTimeFrom(new Date(frame.at))
    const policyOptions = optionsFor(options.mode, detector.activity)

    while (ownerIndex < recording.ownerMessages.length && recording.ownerMessages[ownerIndex].at <= frame.at) {
      lastOwnerAt = recording.ownerMessages[ownerIndex].at
      state = observeInitiative(state, { type: 'owner-message' }, initiativeTimeFrom(new Date(lastOwnerAt)), policyOptions)
      ownerIndex += 1
    }

    const found = detector.observe({ at: frame.at, thumbnail: frame.thumbnail, ...(frame.app ? { app: frame.app } : {}) })
    for (const event of found) {
      events.push(event)
      state = observeInitiative(state, { type: 'perceived', salience: event.salience }, time, policyOptions)
    }

    // The pause after a line and its follow-up count from the end of its speech, as in the app.
    if (speechEnd !== undefined && frame.at >= speechEnd) {
      state = observeInitiative(state, { type: 'speech-ended' }, initiativeTimeFrom(new Date(speechEnd)), policyOptions, random)
      speechEnd = undefined
    }

    const host = { ownerActive: false, speechPlaying: frame.at < speakingUntil, turnRunning: false, intentions: 0 }
    const { state: next, decision } = decideInitiative(state, host, time, random, policyOptions)
    state = next
    if (decision.kind !== 'turn')
      continue

    const since = lastTurnAt ?? frame.at - RING_MS
    const ring = recording.frames.slice(0, index + 1).filter(candidate => candidate.at > frame.at - RING_MS)
    const fresh = events.filter(event => event.at > since)
    const eventTimes = fresh.map(event => event.at)
    if (withAnchor) {
      // A scene change or an app switch starts a new scene, and its first frame becomes the anchor.
      const anchorAt = sceneAnchorAt({
        frames: ring,
        boundaries: events.filter(event => event.type === 'scene-change' || event.type === 'app-switch').map(event => event.at),
        ...(anchorFrame ? { previous: anchorFrame.at } : {}),
      })
      anchorFrame = ring.find(candidate => candidate.at === anchorAt) ?? anchorFrame
    }
    const anchor = withAnchor ? anchorFrame : undefined
    const sheet = withSheet
      ? pickContactSheet({ frames: ring, eventTimes, since }).map(pick => ring[pick.index])
      : withRecentSheet ? pickRecentSheet(ring).map(position => ring[position]) : undefined
    // The recent sheet goes with the newest frame at full size. The other sheet goes alone.
    const picked = withRecentSheet
      ? [frame]
      : sheet ? [] : pickFreshKeyframes({ frames: ring, eventTimes, since, maxImages: anchor ? maxImages - 1 : maxImages }).map(pick => ring[pick.index])
    const screen: InitiativeScreenContext = {
      ...(frame.app ? { app: frame.app } : {}),
      frameAgesMs: picked.map(candidate => frame.at - candidate.at),
      ...(sheet?.length ? { contactSheetAgesMs: sheet.map(candidate => frame.at - candidate.at) } : {}),
      ...(anchor ? { anchorAgeMs: frame.at - anchor.at } : {}),
      events: fresh.map(event => ({ type: event.type, ageMs: frame.at - event.at, ...(event.app ? { app: event.app } : {}) })),
    }
    const notice = initiativeNoticeText({
      mode: options.mode,
      lineLength: drawLineLength({ mode: options.mode, smallTalk: false, activity: detector.activity, hasNotes: timeline.notes.length > 0 }, random),
      trigger: decision.trigger,
      ...(decision.speechType ? { speechType: decision.speechType } : {}),
      now: frame.at,
      localMinutes: time.localMinutes,
      ...(lastOwnerAt !== undefined ? { lastOwnerAt } : {}),
      ...(lines.length ? { lastSpokeAt: lines.at(-1)!.at } : {}),
      recentLines: lines.slice(-3).map(line => line.text),
      screen,
      timeline,
    })

    turns += 1
    images += picked.length + (sheet?.length ? 1 : 0) + (anchor ? 1 : 0)
    lastTurnAt = frame.at
    const reply = await speak({
      at: frame.at,
      trigger: decision.trigger,
      ...(decision.speechType ? { speechType: decision.speechType } : {}),
      notice,
      endMarker: initiativeEndMarker({}),
      frames: picked,
      ...(sheet?.length ? { sheet } : {}),
      ...(anchor ? { anchor } : {}),
    })
    usage.input += reply.usage?.input ?? 0
    usage.output += reply.usage?.output ?? 0
    usage.cached += reply.usage?.cached ?? 0
    requests += reply.requests ?? 1
    toolCalls += reply.toolCalls ?? 0
    cuts += reply.cut ? 1 : 0

    const { spoken, markers } = splitReply(reply.text)
    for (const marker of markers) {
      timeline = marker.kind === 'note'
        ? addTimelineNotes(timeline, [{ at: frame.at, text: marker.text, source: 'model' }])
        : marker.kind === 'scene' ? setTimelineScene(timeline, marker.text, frame.at) : setTimelineCast(timeline, marker.text, frame.at)
    }
    if (spoken) {
      lines.push({ at: frame.at, text: spoken, trigger: decision.trigger, ...(decision.speechType ? { speechType: decision.speechType } : {}), frames: sheet?.length ? [...sheet, ...picked] : picked, ...(reply.firstTextMs !== undefined ? { firstTextMs: reply.firstTextMs } : {}) })
      speakingUntil = frame.at + spoken.length * SPEECH_MS_PER_CHARACTER
      speechEnd = speakingUntil
    }
    else {
      silent += 1
    }
    const turnNext = [...reply.text.matchAll(MARKER)].map(match => nextFromMarker(match[0])).filter(value => value !== undefined).at(-1)
    missingEnd += spoken && !turnNext ? 1 : 0
    state = observeInitiative(state, { type: 'turn-finished', outcome: spoken ? 'spoke' : 'silent', ...(spoken && turnNext ? { next: turnNext } : {}) }, time, policyOptions, random)
  }

  return {
    durationMs: Math.max(0, (recording.frames.at(-1)?.at ?? firstAt) - firstAt),
    turns,
    silent,
    images,
    requests,
    toolCalls,
    cuts,
    missingEnd,
    usage,
    lines,
    events,
    timeline,
  }
}
