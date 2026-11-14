import type { InitiativeMode, InitiativeOptions, InitiativeTime, InitiativeTrigger } from './initiative'
import type { SpeechType } from './speech-types'

import { createInitiativeState, decideInitiative, isSpeechStale, observeInitiative } from './initiative'
import { SPEECH_TYPES } from './speech-types'

/**
 * A synthetic input stream for the initiative policy. All times are milliseconds from the scenario start.
 * Step 3 replaces the synthetic events with recorded detector events of a real session.
 */
export interface Scenario {
  readonly name: string
  readonly durationMs: number
  /** The host checks the policy at this interval. @default 1000 */
  readonly tickMs?: number
  /** @default 'idle' */
  readonly mode?: InitiativeMode
  /** Minutes since local midnight at the start. @default 600, that is 10:00 */
  readonly startMinutes?: number
  /** Detector events. */
  readonly events: readonly { readonly at: number, readonly salience: number }[]
  /** Periods where the owner types or speaks. Each period ends with an owner message. */
  readonly ownerActivity: readonly { readonly from: number, readonly to: number }[]
}

/** How the simulated host and model behave after a turn starts. */
export interface SimulatedModel {
  /** Time from the decision to the start of playback: the model call and the first speech audio. */
  readonly responseMs: number
  /** Time that the speech plays. */
  readonly speechMs: number
  /** The chance that the model stays silent, for each hint. An undefined hint means a turn without a hint. */
  readonly silenceChance: (speechType: SpeechType | undefined) => number
}

/** One decision turn of a simulation run. */
export interface SimulatedTurn {
  readonly at: number
  readonly trigger: InitiativeTrigger
  readonly speechType?: SpeechType
  readonly outcome: 'spoke' | 'silent' | 'dropped'
  /** The owner was active or speech played at the decision. A correct policy never starts a turn then. */
  readonly gateBroken: boolean
}

/** The metrics of the ADR validation that need no model output. */
export interface SimulationMetrics {
  readonly turnsPerMinute: number
  readonly spokenPerMinute: number
  /** The share of decision turns where the model stayed silent. */
  readonly silentTurnShare: number
  /** The share of time without character speech. */
  readonly silenceShare: number
  readonly droppedTurns: number
  /** Shannon entropy of the hinted speech types of spoken turns, divided by its maximum. 0 is one type, 1 is an even mix. */
  readonly speechTypeEntropy: number
  /** The longest run of the same hinted speech type in spoken turns. */
  readonly longestTypeRun: number
  /** Standard deviation of the gaps between spoken turns, divided by their mean. 0 is a fixed timer. */
  readonly gapVariation: number
  /** The share of events with salience 0.6 or more that a turn followed within 30 seconds. */
  readonly reactedShare: number
  readonly gateBreaks: number
}

export interface SimulationResult {
  readonly turns: readonly SimulatedTurn[]
  readonly metrics: SimulationMetrics
}

/**
 * The default simulated model. It answers in 3 seconds and speaks for 5 seconds.
 * It stays silent more often on a `watch-quietly` hint, as the hint asks.
 */
export const simulatedModel: SimulatedModel = {
  responseMs: 3_000,
  speechMs: 5_000,
  silenceChance: speechType => speechType === 'watch-quietly' ? 0.6 : 0.1,
}

const SALIENT_EVENT = 0.6
const REACTION_WINDOW_MS = 30_000
/** The epoch time of a scenario start. The value is arbitrary, because the policy reads only differences and local minutes. */
const SCENARIO_EPOCH = Date.UTC(2026, 0, 1)

/**
 * Runs the initiative policy against a scenario with a fake clock and a seeded random source.
 * The same scenario, options, and seed always give the same result.
 *
 * Call stack:
 *
 * runScenario
 *   -> {@link observeInitiative} (scenario events, owner messages, turn results)
 *   -> {@link decideInitiative} (each tick)
 *   -> {@link isSpeechStale} (at the start of playback)
 *   -> {@link measure}
 */
export function runScenario(scenario: Scenario, options: InitiativeOptions, seed: number, model: SimulatedModel = simulatedModel): SimulationResult {
  const tickMs = scenario.tickMs ?? 1_000
  const random = createSeededRandom(seed)
  const timeAt = (offset: number) => scenarioTime(scenario.startMinutes ?? 600, offset)

  let state = createInitiativeState(timeAt(0), scenario.mode ?? 'idle')
  const events = [...scenario.events].sort((a, b) => a.at - b.at)
  const ownerEnds = scenario.ownerActivity.map(activity => activity.to).sort((a, b) => a - b)
  let eventIndex = 0
  let ownerIndex = 0
  let playbackAt: number | undefined
  let speechEndsAt = -Infinity
  let speakingMs = 0
  const turns: SimulatedTurn[] = []
  let pending: Omit<SimulatedTurn, 'outcome'> | undefined

  for (let offset = 0; offset <= scenario.durationMs; offset += tickMs) {
    const time = timeAt(offset)
    while (eventIndex < events.length && events[eventIndex].at <= offset) {
      state = observeInitiative(state, { type: 'perceived', salience: events[eventIndex].salience }, time, options)
      eventIndex++
    }
    while (ownerIndex < ownerEnds.length && ownerEnds[ownerIndex] <= offset) {
      state = observeInitiative(state, { type: 'owner-message' }, time, options)
      ownerIndex++
    }

    const host = {
      ownerActive: scenario.ownerActivity.some(activity => activity.from <= offset && offset < activity.to),
      speechPlaying: offset < speechEndsAt,
      turnRunning: false,
      intentions: 0,
    }

    if (pending && playbackAt !== undefined && offset >= playbackAt) {
      let outcome: SimulatedTurn['outcome']
      if (random() < model.silenceChance(pending.speechType)) {
        outcome = 'silent'
      }
      else if (isSpeechStale(state, host)) {
        outcome = 'dropped'
      }
      else {
        outcome = 'spoke'
        speechEndsAt = offset + model.speechMs
        speakingMs += Math.min(model.speechMs, scenario.durationMs - offset)
      }
      state = observeInitiative(state, { type: 'turn-finished', outcome }, time, options)
      turns.push({ ...pending, outcome })
      pending = undefined
      playbackAt = undefined
      continue
    }

    const result = decideInitiative(state, host, time, random, options)
    state = result.state
    if (result.decision.kind === 'turn') {
      pending = {
        at: offset,
        trigger: result.decision.trigger,
        gateBroken: host.ownerActive || host.speechPlaying,
        ...(result.decision.speechType ? { speechType: result.decision.speechType } : {}),
      }
      playbackAt = offset + model.responseMs
    }
  }

  return { turns, metrics: measure(scenario, turns, speakingMs) }
}

/**
 * Creates a deterministic uniform random stream from one seed, with the mulberry32 algorithm.
 * `packages/motion-driver-magic` has the same generator. A shared package can own both later.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

/**
 * Creates detector events at random times, as a Poisson process.
 * Each event has a salience between `salience.min` and `salience.max`.
 */
export function randomEvents(options: { seed: number, from: number, to: number, perMinute: number, salience: { min: number, max: number } }) {
  const random = createSeededRandom(options.seed)
  const events: { at: number, salience: number }[] = []
  const meanGapMs = 60_000 / options.perMinute
  let at = options.from
  while (true) {
    // Exponential gaps give a Poisson process. `1 - random()` is above 0, so the logarithm is finite.
    at += -Math.log(1 - random()) * meanGapMs
    if (at >= options.to)
      return events
    events.push({ at: Math.round(at), salience: options.salience.min + random() * (options.salience.max - options.salience.min) })
  }
}

function scenarioTime(startMinutes: number, offset: number): InitiativeTime {
  const totalMinutes = startMinutes + Math.floor(offset / 60_000)
  return {
    now: SCENARIO_EPOCH + offset,
    localMinutes: totalMinutes % 1440,
    localDay: `day-${Math.floor(totalMinutes / 1440)}`,
  }
}

function measure(scenario: Scenario, turns: readonly SimulatedTurn[], speakingMs: number): SimulationMetrics {
  const minutes = scenario.durationMs / 60_000
  const spoken = turns.filter(turn => turn.outcome === 'spoke')
  const silent = turns.filter(turn => turn.outcome === 'silent')

  const typeCounts = new Map<SpeechType, number>()
  let longestTypeRun = 0
  let run = 0
  let previous: SpeechType | undefined
  for (const turn of spoken) {
    if (!turn.speechType)
      continue
    typeCounts.set(turn.speechType, (typeCounts.get(turn.speechType) ?? 0) + 1)
    run = turn.speechType === previous ? run + 1 : 1
    previous = turn.speechType
    longestTypeRun = Math.max(longestTypeRun, run)
  }
  const hinted = [...typeCounts.values()].reduce((sum, count) => sum + count, 0)
  const entropy = [...typeCounts.values()].reduce((sum, count) => {
    const share = count / hinted
    return sum - share * Math.log(share)
  }, 0)

  const gaps = spoken.slice(1).map((turn, index) => turn.at - spoken[index].at)
  const meanGap = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length
  const gapDeviation = Math.sqrt(gaps.reduce((sum, gap) => sum + (gap - meanGap) ** 2, 0) / gaps.length)

  const salient = scenario.events.filter(event => event.salience >= SALIENT_EVENT)
  const reacted = salient.filter(event => turns.some(turn => turn.at >= event.at && turn.at - event.at <= REACTION_WINDOW_MS))

  return {
    turnsPerMinute: turns.length / minutes,
    spokenPerMinute: spoken.length / minutes,
    silentTurnShare: turns.length ? silent.length / turns.length : 0,
    silenceShare: 1 - speakingMs / scenario.durationMs,
    droppedTurns: turns.filter(turn => turn.outcome === 'dropped').length,
    speechTypeEntropy: hinted ? entropy / Math.log(SPEECH_TYPES.length) : 0,
    longestTypeRun,
    gapVariation: gaps.length > 1 ? gapDeviation / meanGap : 0,
    reactedShare: salient.length ? reacted.length / salient.length : 1,
    gateBreaks: turns.filter(turn => turn.gateBroken).length,
  }
}
