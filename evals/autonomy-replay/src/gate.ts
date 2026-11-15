import type { GeminiDecisionClient } from '@proj-airi/core-agent'

import type { RecordedFrame, Recording } from './recording'

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { DecisionRequestError, SCREEN_GATE, SCREEN_LOOK_QUESTIONS, screenGateInput } from '@proj-airi/core-agent'
import { array, boolean, number, object, optional, parse, record, string } from 'valibot'

import { frameImage } from './recording'

/** One look of the screen: what the decision model answered about the frame at `at`. The chances are from 0 to 1. */
export interface GateLook {
  /** The time of the current frame, as epoch milliseconds. */
  readonly at: number
  /** The chance that the frame shows a moment to react to. The screen gate reads it. */
  readonly probability: number
  /** The chance that the frame shows a roster screen. The roster watch reads it. */
  readonly roster: number
  readonly inputTokens: number
}

/** One event that a person or a model marked on a recording. The gate trace scores against them. */
export interface GateLabel {
  /** The time of the event in seconds from the start of the recording. */
  readonly at: number
  readonly type: string
  /** A moment that a friend beside the owner speaks about, for example a kill. The gate must pass these. */
  readonly important: boolean
}

/** The answer of the decision model for one look. */
export type GateAsk = (previous: string, current: string, signal?: AbortSignal) => Promise<{ probability: number, roster: number, inputTokens: number }>

/**
 * Asks the decision model the questions of one look in one request, as the app asks them.
 *
 * @param client The client of the decision model.
 */
export function screenLookAsk(client: Pick<GeminiDecisionClient, 'decide'>): GateAsk {
  return async (previous, current, signal) => {
    const result = await client.decide(screenGateInput(previous, current), SCREEN_LOOK_QUESTIONS, signal)
    return { probability: result.answers.react.probability, roster: result.answers.roster.probability, inputTokens: result.inputTokens }
  }
}

/**
 * How the trace calls the decision model.
 *
 * The free tier of the Gemini API allows 50,000 input tokens each minute, and one look costs about 750. The server
 * answers 429 above the limit, and the limit frees after a part of a minute.
 */
const PACE = {
  /** The least time between the starts of two looks. */
  minIntervalMs: 1_100,
  /** The wait after 429. */
  rateLimitWaitMs: 20_000,
  /** The wait after a server error. */
  serverErrorWaitMs: 3_000,
  /** The retries of one look. Then the trace rejects, and the next run goes on from the saved looks. */
  maxRetries: 8,
  /** The trace saves its looks after this many new ones, so a stopped run loses little. */
  saveEvery: 20,
} as const

const labelsSchema = object({
  events: array(object({ at: number(), type: string(), important: optional(boolean()) })),
})

const savedSchema = object({
  question: string(),
  looks: record(string(), object({ probability: number(), roster: number(), inputTokens: number() })),
})

/** The file name of the labels in a recording folder. */
const LABELS_FILE = 'labels.json'

/** The file name of the saved looks in a recording folder. */
const TRACE_FILE = 'gate-trace.json'

/**
 * Reads `labels.json` of a recording folder: `{ "events": [{ "at": 32, "type": "kill", "important": true }] }`.
 * A recording without the file has no labels, and its trace gets no score.
 */
export function loadGateLabels(recording: Recording): GateLabel[] | undefined {
  const path = join(recording.directory, LABELS_FILE)
  if (!existsSync(path))
    return undefined
  return parse(labelsSchema, JSON.parse(readFileSync(path, 'utf8'))).events.map(event => ({ at: event.at, type: event.type, important: event.important ?? false }))
}

/** Names the questions and the settings of a look. Saved looks of other questions are not answers to these. */
function questionKey() {
  return createHash('sha256').update(JSON.stringify([SCREEN_LOOK_QUESTIONS, screenGateInput('', ''), SCREEN_GATE.stepMs])).digest('hex').slice(0, 16)
}

/**
 * The frame pairs of the looks: one look each step, with the newest frame at that time. The earlier frame of a look
 * is the current frame of the look before it, as a live gate keeps it. The capture times of a recording of the app
 * are not on an exact grid, so a look takes the newest frame at or before its time.
 */
function lookPairs(frames: readonly RecordedFrame[]) {
  const pairs: { previous: RecordedFrame, current: RecordedFrame }[] = []
  let previous = frames[0]
  if (!previous)
    return pairs
  let index = 0
  for (let time = previous.at + SCREEN_GATE.stepMs; time <= frames.at(-1)!.at; time += SCREEN_GATE.stepMs) {
    while (index + 1 < frames.length && frames[index + 1].at <= time)
      index += 1
    const current = frames[index]
    // A gap in the capture gives no new frame for a look, and the same frame twice shows no change.
    if (current.at > previous.at)
      pairs.push({ previous, current })
    previous = current
  }
  return pairs
}

async function askWithRetry(ask: GateAsk, previous: string, current: string, signal: AbortSignal | undefined) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ask(previous, current, signal)
    }
    catch (error) {
      // Only a full rate limit and a server error can pass later. Another refusal fails the same way again.
      const retryable = error instanceof DecisionRequestError && (error.status === 429 || error.status >= 500)
      if (!retryable || attempt >= PACE.maxRetries)
        throw error
      await sleep(error.status === 429 ? PACE.rateLimitWaitMs : PACE.serverErrorWaitMs, undefined, { signal })
    }
  }
}

/**
 * Asks the questions of a screen look about a recording, one look each {@link SCREEN_GATE.stepMs}, as the app asks
 * them live.
 *
 * - Each look compares the frame of one step ago with the current frame.
 * - The looks are saved to `gate-trace.json` in the recording folder. A later run asks only for the missing looks, so
 *   a stopped run and a second run cost no tokens again. A change of the question starts the file again.
 * - `minIntervalMs` paces the requests for the rate limit of the server.
 *
 * Resolves to the looks in time order.
 */
export async function traceGate(recording: Recording, options: { ask: GateAsk, signal?: AbortSignal, minIntervalMs?: number }): Promise<GateLook[]> {
  const path = join(recording.directory, TRACE_FILE)
  const question = questionKey()
  const looks = new Map<number, { probability: number, roster: number, inputTokens: number }>()
  if (existsSync(path)) {
    const saved = parse(savedSchema, JSON.parse(readFileSync(path, 'utf8')))
    if (saved.question === question) {
      for (const [at, look] of Object.entries(saved.looks))
        looks.set(Number(at), look)
    }
  }
  const save = async () => {
    // The rename replaces the file in one step, so a stop in the middle of a write leaves the old file whole.
    await writeFile(`${path}.tmp`, JSON.stringify({ question, looks: Object.fromEntries(looks) }))
    await rename(`${path}.tmp`, path)
  }

  const pairs = lookPairs(recording.frames)

  let unsaved = 0
  try {
    for (const { previous, current } of pairs) {
      if (looks.has(current.at))
        continue
      const startedAt = performance.now()
      looks.set(current.at, await askWithRetry(options.ask, await frameImage(recording, previous), await frameImage(recording, current), options.signal))
      if (++unsaved >= PACE.saveEvery) {
        await save()
        unsaved = 0
      }
      const wait = (options.minIntervalMs ?? PACE.minIntervalMs) - (performance.now() - startedAt)
      if (wait > 0)
        await sleep(wait, undefined, { signal: options.signal })
    }
  }
  finally {
    if (unsaved)
      await save()
  }
  return pairs.flatMap(({ current }) => {
    const look = looks.get(current.at)
    return look ? [{ at: current.at, ...look }] : []
  })
}

/** What the gate did on a recording at one threshold. Shares are from 0 to 1. */
export interface GateScore {
  readonly threshold: number
  /** The looks that the gate passed, for each minute of the recording. */
  readonly passesPerMinute: number
  /** The lines for each minute when a pass starts a line and no line starts in `minLineGapMs` after another. */
  readonly linesPerMinute: number
  /** The share of the important events that a pass caught. Missing without important labels. */
  readonly recall?: number
  /** The share of the passes at an important event. Missing without labels or passes. */
  readonly precision?: number
  /** The share of the passes at any labeled event. Missing without labels or passes. */
  readonly onAnyEvent?: number
}

/**
 * Scores the looks of a gate trace at one threshold.
 *
 * A look sees a change one step after it happened at the latest. So a pass catches an event when the event lies in
 * the step before the pass, with both ends.
 */
export function scoreGate(looks: readonly GateLook[], labels: readonly GateLabel[] | undefined, options: {
  /** The time of the first frame, as epoch milliseconds. The label times count from it. */
  startedAt: number
  threshold: number
  /**
   * The least time between the starts of two lines.
   *
   * @default 6000, the cooldown of the design
   */
  minLineGapMs?: number
}): GateScore {
  const passes = looks.filter(look => look.probability >= options.threshold).map(look => look.at)
  const minutes = looks.length * SCREEN_GATE.stepMs / 60_000
  const minLineGapMs = options.minLineGapMs ?? 6_000
  let lines = 0
  let lastLineAt = Number.NEGATIVE_INFINITY
  for (const at of passes) {
    if (at - lastLineAt >= minLineGapMs) {
      lines += 1
      lastLineAt = at
    }
  }
  const base = {
    threshold: options.threshold,
    passesPerMinute: minutes ? passes.length / minutes : 0,
    linesPerMinute: minutes ? lines / minutes : 0,
  }
  if (!labels)
    return base

  const timeOf = (label: GateLabel) => options.startedAt + label.at * 1000
  const catches = (pass: number, label: GateLabel) => timeOf(label) <= pass && timeOf(label) >= pass - SCREEN_GATE.stepMs
  const important = labels.filter(label => label.important)
  return {
    ...base,
    ...(important.length ? { recall: important.filter(label => passes.some(pass => catches(pass, label))).length / important.length } : {}),
    ...(passes.length
      ? {
          precision: passes.filter(pass => important.some(label => catches(pass, label))).length / passes.length,
          onAnyEvent: passes.filter(pass => labels.some(label => catches(pass, label))).length / passes.length,
        }
      : {}),
  }
}
