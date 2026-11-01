import type { SpeechType } from './speech-types'

import { merge } from '@moeru/std'

import { drawSpeechType, RECENT_SPEECH_TYPE_COUNT } from './speech-types'

/**
 * How the character starts speech on its own.
 *
 * - `idle`: the character talks now and then. Events push it a little, and long quiet pushes it more.
 * - `commentary`: a commentary mission runs. Events push it hard, and the periodic interval is short.
 */
export type InitiativeMode = 'idle' | 'commentary'

/**
 * The time of one call. The host reads its clock once and passes all values, so a test can fix them.
 */
export interface InitiativeTime {
  /** Epoch milliseconds. All durations come from this value. */
  readonly now: number
  /** Minutes since local midnight, 0 to 1439. Quiet hours use it. */
  readonly localMinutes: number
  /** The local calendar day, for example `2026-10-29`. The daily turn budget starts again when it changes. */
  readonly localDay: string
}

/** Settings of one mode. */
export interface InitiativeModeOptions {
  /**
   * Quiet time of this length takes boredom to 1, which is the base threshold.
   * With no events and full energy, a turn comes near this interval.
   */
  boredomIntervalMs: number
  /**
   * The pressure that one event of salience 1 adds. 1 is the base threshold.
   * Salience counts squared, so many small screen changes add less pressure than one large change.
   */
  eventGain: number
  /** Event pressure halves in this time. */
  pressureHalfLifeMs: number
  /** No turn starts for this time after a turn ends. */
  refractoryMs: number
}

/** Settings of the initiative policy. Resolve them with {@link resolveInitiativeOptions}. */
export interface InitiativeOptions {
  modes: Record<InitiativeMode, InitiativeModeOptions>
  /**
   * Each cycle between turns multiplies the threshold by a random factor from `1 - thresholdJitter` to `1 + thresholdJitter`.
   * The gaps between turns vary this way.
   * @default 0.3
   */
  thresholdJitter: number
  /**
   * No turn starts for this time after an owner message. The reply to the owner comes first.
   * @default 30000
   */
  ownerGraceMs: number
  /**
   * No turn starts in this range of local minutes. A range can pass midnight, for example 1380 to 420.
   * Equal values or no range turn quiet hours off.
   * @default undefined
   */
  quietHours?: { startMinutes: number, endMinutes: number }
  /**
   * Epoch milliseconds. The owner asked for quiet, so no turn starts until this time.
   * @default undefined
   */
  quietUntil?: number
  /**
   * The maximum count of decision turns in one local day. Each turn is one model call, also when the model stays silent.
   * @default 200
   */
  dailyTurnBudget: number
  /**
   * After the model chooses silence, pressure and boredom keep this share.
   * Silence lowers the drive only in part, so the character tries again sooner than after speech.
   * @default 0.5
   */
  silentRetain: number
  /**
   * An event with this salience or more, after a decision, makes the speech of that decision stale.
   * @default 0.6
   */
  staleSalience: number
  /**
   * The share of turns that get no speech type hint. The model then picks freely.
   * @default 0.25
   */
  hintlessShare: number
}

/** Settings from the owner or a mission. Each missing value takes its default. */
export type InitiativeSettings = Partial<Omit<InitiativeOptions, 'modes'>> & {
  modes?: { [Mode in InitiativeMode]?: Partial<InitiativeModeOptions> }
}

/**
 * The defaults are conservative, because the feature is opt-in and each turn costs a model call.
 * Idle talk comes about every 15 minutes. Commentary talks about every 45 seconds and reacts fast to events.
 */
const DEFAULT_OPTIONS: InitiativeOptions = {
  modes: {
    idle: {
      boredomIntervalMs: 15 * 60_000,
      eventGain: 0.8,
      pressureHalfLifeMs: 60_000,
      refractoryMs: 90_000,
    },
    commentary: {
      boredomIntervalMs: 45_000,
      eventGain: 1.5,
      pressureHalfLifeMs: 20_000,
      refractoryMs: 6_000,
    },
  },
  thresholdJitter: 0.3,
  ownerGraceMs: 30_000,
  dailyTurnBudget: 200,
  silentRetain: 0.5,
  staleSalience: 0.6,
  hintlessShare: 0.25,
}

/**
 * How the inner state changes with time and turns.
 * These values set the character's temperament, not owner settings, so they are not options.
 */
const INNER_DYNAMICS = {
  /** Lost energy halves in this time, so rest restores energy. */
  energyRecoveryHalfLifeMs: 20 * 60_000,
  /** Each spoken turn spends this much energy. */
  energyPerSpokenTurn: 0.12,
  /** Mood halves toward 0 in this time. */
  moodHalfLifeMs: 60 * 60_000,
  /** An owner message raises mood by this much. */
  moodPerOwnerMessage: 0.1,
  /** Each turn moves mood by a random amount up to this value, so mood does not stay flat. */
  moodDrift: 0.05,
  /** Curiosity halves in this time. */
  curiosityHalfLifeMs: 10 * 60_000,
  /** An event of salience 1 raises curiosity by this much. */
  curiosityPerSalience: 0.3,
  /** Low energy multiplies the threshold by up to `1 + energyThresholdGain`. */
  energyThresholdGain: 0.5,
  /** Each open intention adds this much drive, so the character brings it up sooner. */
  drivePerIntention: 0.2,
  /** The drive from intentions stops here, so a list of intentions does not make the character talk all the time. */
  maxIntentionDrive: 0.4,
  /**
   * Each autonomous line without an owner reaction multiplies the idle interval by this step.
   * The owner's next message returns the interval to its setting.
   */
  unansweredIntervalStep: 1.3,
  /** The idle interval grows up to this multiple of its setting. */
  maxUnansweredIntervalFactor: 3,
}

/** The inner state of the character. Code updates it from time and events, and the speech type draw reads it. */
export interface InnerState {
  /** 0 to 1. Spoken turns spend it, and rest restores it. Low energy raises the threshold and favors quiet speech. */
  readonly energy: number
  /** -1 to 1. Owner messages raise it, and it drifts back to 0. High mood favors jokes. */
  readonly mood: number
  /**
   * 0 and up. Quiet time raises it by 1 per boredom interval, with no upper limit, so quiet time alone always starts a turn in the end.
   * Speech and owner messages set it to 0. It is the boredom term of the drive.
   */
  readonly boredom: number
  /** 0 to 1. Events raise it, and it decays. High curiosity favors questions. */
  readonly curiosity: number
}

/** Why a turn started: the larger part of the drive. */
export type InitiativeTrigger = 'event' | 'boredom' | 'intention'

/** A decided turn that waits for its result. */
export interface PendingTurn {
  readonly startedAt: number
  readonly trigger: InitiativeTrigger
  /** The hint for the model. Undefined in the hintless share of turns. */
  readonly speechType?: SpeechType
}

/**
 * The state of the initiative policy. It is plain data. The host keeps it in memory and replaces it with each result.
 * It is runtime state only. A restart begins with {@link createInitiativeState}.
 */
export interface InitiativeState {
  readonly mode: InitiativeMode
  /** Event pressure at `updatedAt`, in threshold units. */
  readonly pressure: number
  readonly inner: InnerState
  /** The time that pressure and inner state were last advanced to. */
  readonly updatedAt: number
  /** The threshold factor of the current cycle. Undefined until the next decision draws it. */
  readonly jitter?: number
  readonly refractoryUntil: number
  readonly lastOwnerAt?: number
  /** The time of the last event with `staleSalience` or more. */
  readonly lastSalientAt?: number
  readonly turn?: PendingTurn
  /** Speech types of the last spoken turns, newest last. */
  readonly recentTypes: readonly SpeechType[]
  /**
   * The count of autonomous lines since the last owner message. Each one makes the idle interval longer, because the
   * owner did not react.
   */
  readonly unanswered: number
  readonly budget: { readonly day: string, readonly turns: number }
}

/**
 * Something that changes the drive.
 *
 * - `perceived`: a detector saw something. `salience` is 0 to 1.
 * - `owner-message`: the owner sent text or finished speech.
 * - `character-spoke`: the character finished a reply that this policy did not start, for example a reply to the owner.
 * - `turn-finished`: the turn that the last decision started ended. `dropped` means that code dropped stale speech.
 * - `mode-changed`: a mission started or ended.
 */
export type InitiativeEvent
  = | { readonly type: 'perceived', readonly salience: number }
    | { readonly type: 'owner-message' }
    | { readonly type: 'character-spoke' }
    | { readonly type: 'turn-finished', readonly outcome: 'spoke' | 'silent' | 'dropped' | 'failed' }
    | { readonly type: 'mode-changed', readonly mode: InitiativeMode }

/** What the host reports at each decision. These values come from other parts of the app and change at any time. */
export interface InitiativeHost {
  /** The owner types or speaks now. */
  readonly ownerActive: boolean
  /** Speech audio plays now. */
  readonly speechPlaying: boolean
  /** A chat turn that this policy did not start runs now, for example a reply to the owner. */
  readonly turnRunning: boolean
  /** The count of open intentions. They add drive. */
  readonly intentions: number
}

/**
 * Why no turn starts. The order is the check order: an earlier reason hides a later one.
 * Owner input comes first, because owner input always wins.
 */
export type InitiativeWaitReason
  = | 'owner-active'
    | 'speech-playing'
    | 'turn-running'
    | 'quiet-hours'
    | 'owner-quiet'
    | 'daily-budget'
    | 'refractory'
    | 'below-threshold'

/** The result of one decision. On `turn`, the host starts one model call and later reports `turn-finished`. */
export type InitiativeDecision
  = | { readonly kind: 'wait', readonly reason: InitiativeWaitReason }
    | {
      readonly kind: 'turn'
      readonly trigger: InitiativeTrigger
      /** The hint for the model. Undefined in the hintless share of turns. */
      readonly speechType?: SpeechType
      /** The drive and the threshold at the decision, for traces and evaluation. */
      readonly drive: number
      readonly threshold: number
    }

/**
 * Resolves settings into complete options. Each missing value takes its default.
 *
 * @example
 * resolveInitiativeOptions({ modes: { idle: { boredomIntervalMs: 600_000 } } }).modes.idle.boredomIntervalMs
 * // => 600000
 */
export function resolveInitiativeOptions(settings: InitiativeSettings = {}): InitiativeOptions {
  const { modes, ...rest } = settings
  return {
    ...merge(DEFAULT_OPTIONS, rest),
    modes: {
      idle: merge(DEFAULT_OPTIONS.modes.idle, modes?.idle),
      commentary: merge(DEFAULT_OPTIONS.modes.commentary, modes?.commentary),
    },
  }
}

/**
 * Reads the time values from a date in the local time zone of the runtime.
 *
 * @example
 * initiativeTimeFrom(new Date(2026, 9, 29, 7, 30))
 * // => { now: date.getTime(), localMinutes: 450, localDay: '2026-10-29' }
 */
export function initiativeTimeFrom(date: Date): InitiativeTime {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return {
    now: date.getTime(),
    localMinutes: date.getHours() * 60 + date.getMinutes(),
    localDay: `${date.getFullYear()}-${month}-${day}`,
  }
}

/** Creates the state at app start: rested, neutral, and not bored. */
export function createInitiativeState(time: InitiativeTime, mode: InitiativeMode = 'idle'): InitiativeState {
  return {
    mode,
    pressure: 0,
    inner: { energy: 1, mood: 0, boredom: 0, curiosity: 0 },
    updatedAt: time.now,
    refractoryUntil: time.now,
    recentTypes: [],
    unanswered: 0,
    budget: { day: time.localDay, turns: 0 },
  }
}

/** Applies one event. It changes no time-based value other than the advance to `time`. */
export function observeInitiative(state: InitiativeState, event: InitiativeEvent, time: InitiativeTime, options: InitiativeOptions): InitiativeState {
  const current = advance(state, time.now, options)

  switch (event.type) {
    case 'perceived': {
      const salience = clamp(event.salience, 0, 1)
      return {
        ...current,
        pressure: current.pressure + salience ** 2 * options.modes[current.mode].eventGain,
        inner: { ...current.inner, curiosity: Math.min(1, current.inner.curiosity + salience * INNER_DYNAMICS.curiosityPerSalience) },
        ...(salience >= options.staleSalience ? { lastSalientAt: time.now } : {}),
      }
    }
    case 'owner-message':
      // The owner gets a normal reply. Pressure from earlier events is old now, and the conversation is not quiet.
      return {
        ...current,
        pressure: 0,
        inner: { ...current.inner, boredom: 0, mood: clamp(current.inner.mood + INNER_DYNAMICS.moodPerOwnerMessage, -1, 1) },
        lastOwnerAt: time.now,
        unanswered: 0,
      }
    case 'character-spoke':
      return { ...current, inner: { ...current.inner, boredom: 0 } }
    case 'mode-changed':
      return { ...current, mode: event.mode }
    case 'turn-finished':
      return finishTurn(current, event.outcome, time.now, options)
  }
}

/**
 * Decides whether a turn starts now. The host calls it on a timer, for example each second.
 *
 * On `turn`, the returned state holds the pending turn and counts it in the daily budget.
 * No other turn starts until the host reports `turn-finished`.
 * The random source draws the threshold jitter, the speech type, and the mood drift.
 */
export function decideInitiative(
  state: InitiativeState,
  host: InitiativeHost,
  time: InitiativeTime,
  random: () => number,
  options: InitiativeOptions,
): { state: InitiativeState, decision: InitiativeDecision } {
  let current = advance(state, time.now, options)
  if (current.budget.day !== time.localDay)
    current = { ...current, budget: { day: time.localDay, turns: 0 } }

  const reason = waitReason(current, host, time, options)
  if (reason)
    return { state: current, decision: { kind: 'wait', reason } }

  // The jitter stays fixed for one cycle. A new draw at each check would make the result depend on how often the host checks.
  const jitter = current.jitter ?? 1 + (random() * 2 - 1) * options.thresholdJitter
  current = { ...current, jitter }

  const threshold = energyFactorOf(current.inner) * jitter
  const { total: drive, intention: intentionDrive } = driveOf(current, host)
  if (drive < threshold)
    return { state: current, decision: { kind: 'wait', reason: 'below-threshold' } }

  const trigger = triggerOf(current.pressure, current.inner.boredom, intentionDrive)
  const speechType = random() < options.hintlessShare
    ? undefined
    : drawSpeechType({ ...current.inner, eventShare: current.pressure / drive, recentTypes: current.recentTypes }, random)
  const mood = clamp(current.inner.mood + (random() * 2 - 1) * INNER_DYNAMICS.moodDrift, -1, 1)

  const turn: PendingTurn = { startedAt: time.now, trigger, ...(speechType ? { speechType } : {}) }
  return {
    state: {
      ...current,
      inner: { ...current.inner, mood },
      turn,
      budget: { day: current.budget.day, turns: current.budget.turns + 1 },
    },
    decision: { kind: 'turn', trigger, drive, threshold, ...(speechType ? { speechType } : {}) },
  }
}

/** What the policy sees at one time, for an inspector. */
export interface InitiativeReadout {
  readonly mode: InitiativeMode
  /** Why no turn starts now. Undefined when the drive reaches the threshold and no gate holds. */
  readonly waitReason?: InitiativeWaitReason
  /** The drive and its parts. The total is their sum. */
  readonly drive: { readonly total: number, readonly pressure: number, readonly boredom: number, readonly intention: number }
  /** The threshold of the current cycle. Before the jitter is drawn, it uses a jitter of 1. */
  readonly threshold: number
  /** Whether the current cycle drew its jitter. The next decision draws it. */
  readonly jitterDrawn: boolean
  readonly inner: InnerState
  /** Milliseconds until the refractory time ends. 0 when it ended. */
  readonly refractoryLeftMs: number
  /** Autonomous lines since the last owner message. */
  readonly unanswered: number
  /** The multiplier of the idle interval from {@link unansweredIntervalFactor}. */
  readonly intervalFactor: number
  readonly budget: { readonly turns: number, readonly limit: number }
  readonly recentTypes: readonly SpeechType[]
  readonly turn?: PendingTurn
}

/**
 * Reads what the policy sees at `time`, without a decision. It changes no state and draws no random value.
 * The values match what {@link decideInitiative} would use at the same time.
 */
export function initiativeReadout(state: InitiativeState, host: InitiativeHost, time: InitiativeTime, options: InitiativeOptions): InitiativeReadout {
  let current = advance(state, time.now, options)
  if (current.budget.day !== time.localDay)
    current = { ...current, budget: { day: time.localDay, turns: 0 } }

  const drive = driveOf(current, host)
  const threshold = energyFactorOf(current.inner) * (current.jitter ?? 1)
  const reason = waitReason(current, host, time, options) ?? (drive.total < threshold ? 'below-threshold' : undefined)
  return {
    mode: current.mode,
    ...(reason ? { waitReason: reason } : {}),
    drive,
    threshold,
    jitterDrawn: current.jitter !== undefined,
    inner: current.inner,
    refractoryLeftMs: Math.max(0, current.refractoryUntil - time.now),
    unanswered: current.unanswered,
    intervalFactor: current.mode === 'idle' ? unansweredIntervalFactor(current.unanswered) : 1,
    budget: { turns: current.budget.turns, limit: options.dailyTurnBudget },
    recentTypes: current.recentTypes,
    ...(current.turn ? { turn: current.turn } : {}),
  }
}

/**
 * Tells whether the speech of the pending turn is stale. The host asks before playback.
 * Speech is stale when the owner is active or sent a message after the decision, or when a salient event came after it.
 * Owner input always wins, and a late line must not play after a newer event.
 */
export function isSpeechStale(state: InitiativeState, host: Pick<InitiativeHost, 'ownerActive'>): boolean {
  if (!state.turn)
    return false
  if (host.ownerActive)
    return true
  const { startedAt } = state.turn
  return (state.lastOwnerAt ?? -Infinity) > startedAt || (state.lastSalientAt ?? -Infinity) > startedAt
}

function waitReason(state: InitiativeState, host: InitiativeHost, time: InitiativeTime, options: InitiativeOptions): InitiativeWaitReason | undefined {
  if (host.ownerActive || (state.lastOwnerAt !== undefined && time.now - state.lastOwnerAt < options.ownerGraceMs))
    return 'owner-active'
  if (host.speechPlaying)
    return 'speech-playing'
  if (host.turnRunning || state.turn)
    return 'turn-running'
  if (options.quietHours && inQuietHours(time.localMinutes, options.quietHours))
    return 'quiet-hours'
  if (options.quietUntil !== undefined && time.now < options.quietUntil)
    return 'owner-quiet'
  if (state.budget.turns >= options.dailyTurnBudget)
    return 'daily-budget'
  if (time.now < state.refractoryUntil)
    return 'refractory'
  return undefined
}

function inQuietHours(minutes: number, range: { startMinutes: number, endMinutes: number }) {
  const { startMinutes, endMinutes } = range
  if (startMinutes === endMinutes)
    return false
  // A range that passes midnight, for example 23:00 to 07:00, holds the minutes after the start or before the end.
  if (startMinutes > endMinutes)
    return minutes >= startMinutes || minutes < endMinutes
  return minutes >= startMinutes && minutes < endMinutes
}

function finishTurn(state: InitiativeState, outcome: 'spoke' | 'silent' | 'dropped' | 'failed', now: number, options: InitiativeOptions): InitiativeState {
  // A result without a pending turn comes from a turn that an earlier state already closed. It changes nothing.
  if (!state.turn)
    return state

  const { turn, ...rest } = state
  // Each closed turn begins a new cycle, so the next decision draws a new jitter.
  const closed: InitiativeState = { ...rest, jitter: undefined }
  const refractoryUntil = now + options.modes[state.mode].refractoryMs

  switch (outcome) {
    case 'spoke':
      return {
        ...closed,
        pressure: 0,
        inner: { ...closed.inner, boredom: 0, energy: Math.max(0, closed.inner.energy - INNER_DYNAMICS.energyPerSpokenTurn) },
        refractoryUntil,
        recentTypes: turn.speechType ? [...closed.recentTypes, turn.speechType].slice(-RECENT_SPEECH_TYPE_COUNT) : closed.recentTypes,
        unanswered: closed.unanswered + 1,
      }
    case 'silent':
    case 'failed':
      // A failed call also waits the refractory time, so a broken provider does not get a call at each check.
      return {
        ...closed,
        pressure: closed.pressure * options.silentRetain,
        inner: { ...closed.inner, boredom: closed.inner.boredom * options.silentRetain },
        refractoryUntil,
      }
    case 'dropped':
      // A newer event or the owner made the speech stale. The newer cause keeps its pressure, and no refractory time
      // follows, so the character can react to the newer event at once.
      return closed
  }
}

/** Moves pressure and inner state forward to `now`. Time never moves back, so an earlier `now` changes nothing. */
function advance(state: InitiativeState, now: number, options: InitiativeOptions): InitiativeState {
  const elapsed = now - state.updatedAt
  if (elapsed <= 0)
    return state

  const mode = options.modes[state.mode]
  // Only idle talk slows down for lines without a reaction. The owner starts commentary, so it keeps its pace.
  const boredomIntervalMs = state.mode === 'idle' ? mode.boredomIntervalMs * unansweredIntervalFactor(state.unanswered) : mode.boredomIntervalMs
  const { energy, mood, boredom, curiosity } = state.inner
  return {
    ...state,
    updatedAt: now,
    pressure: state.pressure * halving(elapsed, mode.pressureHalfLifeMs),
    inner: {
      energy: 1 - (1 - energy) * halving(elapsed, INNER_DYNAMICS.energyRecoveryHalfLifeMs),
      mood: mood * halving(elapsed, INNER_DYNAMICS.moodHalfLifeMs),
      boredom: boredom + elapsed / boredomIntervalMs,
      curiosity: curiosity * halving(elapsed, INNER_DYNAMICS.curiosityHalfLifeMs),
    },
  }
}

/**
 * The multiplier of the idle interval after `unanswered` autonomous lines without an owner reaction.
 *
 * @example
 * unansweredIntervalFactor(0)
 * // => 1
 * unansweredIntervalFactor(2)
 * // => 1.69
 */
export function unansweredIntervalFactor(unanswered: number): number {
  return Math.min(INNER_DYNAMICS.maxUnansweredIntervalFactor, INNER_DYNAMICS.unansweredIntervalStep ** Math.max(0, unanswered))
}

/** Low energy raises the threshold. */
function energyFactorOf(inner: InnerState) {
  return 1 + (1 - inner.energy) * INNER_DYNAMICS.energyThresholdGain
}

/** The drive and its parts. Intentions add a capped part. */
function driveOf(state: InitiativeState, host: InitiativeHost) {
  const intention = Math.min(INNER_DYNAMICS.maxIntentionDrive, Math.max(0, host.intentions) * INNER_DYNAMICS.drivePerIntention)
  return { total: state.pressure + state.inner.boredom + intention, pressure: state.pressure, boredom: state.inner.boredom, intention }
}

/** The trigger is the largest part of the drive. A tie goes to the event, then to boredom. */
function triggerOf(pressure: number, boredom: number, intentionDrive: number): InitiativeTrigger {
  if (pressure >= boredom && pressure >= intentionDrive)
    return 'event'
  return boredom >= intentionDrive ? 'boredom' : 'intention'
}

/** The share that remains after `elapsed` milliseconds of decay with the given half-life. */
function halving(elapsed: number, halfLifeMs: number) {
  return 0.5 ** (elapsed / halfLifeMs)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
