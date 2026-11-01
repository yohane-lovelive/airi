import type { InitiativeMode, InitiativeOptions, InitiativeScreenContext, InitiativeTrigger, SpeechType, Timeline } from '@proj-airi/core-agent'
import type { ScreenEvent } from '@proj-airi/stage-shared/perception'

import type { RecordedFrame, Recording } from './recording'

import {
  addTimelineNotes,
  commentaryIntervalFactor,
  createInitiativeState,
  decideInitiative,
  EMPTY_TIMELINE,
  initiativeNoticeText,
  initiativeTimeFrom,
  observeInitiative,
  resolveInitiativeOptions,
  setTimelineScene,
  timelineMarkerFrom,
} from '@proj-airi/core-agent'
import { pickFreshKeyframes, ScreenDetector } from '@proj-airi/stage-shared/perception'

/** The frame policies that the replay compares. Step 3-6c adds `contact-sheet` and `scene-anchor`. */
export const FRAME_POLICIES = ['fresh-keyframes'] as const
export type FramePolicyName = typeof FRAME_POLICIES[number]

/** Settings of one replay. */
export interface ReplayOptions {
  readonly mode: InitiativeMode
  readonly policy: FramePolicyName
  /** The seed of the random source, so two runs of one recording make the same decisions until the replies differ. */
  readonly seed: number
  /** The most frames for one turn. The app sends three, or two in commentary. */
  readonly maxImagesPerTurn?: number
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
  /** The picked frames, oldest first. The last one goes at full size. */
  readonly frames: readonly RecordedFrame[]
}

/** What the speaking model answered for one turn. */
export interface SpokenReply {
  readonly text: string
  readonly usage?: TokenUsage
}

/** One line that the character spoke in the replay. */
export interface ReplayLine {
  readonly at: number
  readonly text: string
  readonly trigger: InitiativeTrigger
  readonly speechType?: SpeechType
  readonly frames: readonly RecordedFrame[]
}

export interface ReplayResult {
  readonly durationMs: number
  readonly turns: number
  readonly silent: number
  readonly images: number
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
 * - The owner messages of the recording reach the policy at their times. Their text was never recorded.
 * - A spoken line holds further turns for its estimated playback time.
 * - The timeline takes the NOTE and SCENE markers of the replies, and each later notice gives it to the model.
 */
export async function replayRecording(recording: Recording, options: ReplayOptions, speak: (turn: ReplayTurn) => Promise<SpokenReply>): Promise<ReplayResult> {
  const random = seededRandom(options.seed)
  const detector = new ScreenDetector({ width: 64, height: 36 })
  const maxImages = options.maxImagesPerTurn ?? (options.mode === 'commentary' ? 2 : 3)
  const firstAt = recording.frames[0]?.at ?? recording.startedAt
  let state = createInitiativeState(initiativeTimeFrom(new Date(firstAt)), options.mode)
  let timeline: Timeline = EMPTY_TIMELINE
  const events: ScreenEvent[] = []
  const lines: ReplayLine[] = []
  const usage = { input: 0, output: 0, cached: 0 }
  let turns = 0
  let silent = 0
  let images = 0
  let speakingUntil = 0
  let lastTurnAt: number | undefined
  let lastOwnerAt: number | undefined
  let ownerIndex = 0

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

    const host = { ownerActive: false, speechPlaying: frame.at < speakingUntil, turnRunning: false, intentions: 0 }
    const { state: next, decision } = decideInitiative(state, host, time, random, policyOptions)
    state = next
    if (decision.kind !== 'turn')
      continue

    const since = lastTurnAt ?? frame.at - RING_MS
    const ring = recording.frames.slice(0, index + 1).filter(candidate => candidate.at > frame.at - RING_MS)
    const fresh = events.filter(event => event.at > since)
    const picks = pickFreshKeyframes({ frames: ring, eventTimes: fresh.map(event => event.at), since, maxImages })
    const picked = picks.map(pick => ring[pick.index])
    const screen: InitiativeScreenContext = {
      ...(frame.app ? { app: frame.app } : {}),
      frameAgesMs: picked.map(candidate => frame.at - candidate.at),
      events: fresh.map(event => ({ type: event.type, ageMs: frame.at - event.at, ...(event.app ? { app: event.app } : {}) })),
    }
    const notice = initiativeNoticeText({
      mode: options.mode,
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
    images += picked.length
    lastTurnAt = frame.at
    const reply = await speak({ at: frame.at, trigger: decision.trigger, ...(decision.speechType ? { speechType: decision.speechType } : {}), notice, frames: picked })
    usage.input += reply.usage?.input ?? 0
    usage.output += reply.usage?.output ?? 0
    usage.cached += reply.usage?.cached ?? 0

    const { spoken, markers } = splitReply(reply.text)
    for (const marker of markers) {
      timeline = marker.kind === 'note'
        ? addTimelineNotes(timeline, [{ at: frame.at, text: marker.text, source: 'model' }])
        : setTimelineScene(timeline, marker.text, frame.at)
    }
    if (spoken) {
      lines.push({ at: frame.at, text: spoken, trigger: decision.trigger, ...(decision.speechType ? { speechType: decision.speechType } : {}), frames: picked })
      speakingUntil = frame.at + spoken.length * SPEECH_MS_PER_CHARACTER
    }
    else {
      silent += 1
    }
    state = observeInitiative(state, { type: 'turn-finished', outcome: spoken ? 'spoke' : 'silent' }, time, policyOptions)
  }

  return {
    durationMs: Math.max(0, (recording.frames.at(-1)?.at ?? firstAt) - firstAt),
    turns,
    silent,
    images,
    usage,
    lines,
    events,
    timeline,
  }
}
