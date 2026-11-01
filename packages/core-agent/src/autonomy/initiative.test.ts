import type { InitiativeHost, InitiativeOptions, InitiativeState, InitiativeTime } from './initiative'

import { describe, expect, it } from 'vitest'

import {
  createInitiativeState,
  decideInitiative,
  initiativeReadout,
  initiativeTimeFrom,
  isSpeechStale,
  observeInitiative,
  resolveInitiativeOptions,
  unansweredIntervalFactor,
} from './initiative'

const START = Date.UTC(2026, 9, 29, 1, 0)
const IDLE: InitiativeHost = { ownerActive: false, speechPlaying: false, turnRunning: false, intentions: 0 }

/** The time `seconds` after the start, at 10:00 local time on one day. */
function at(seconds: number, localDay = '2026-10-29', localMinutes = 600): InitiativeTime {
  return { now: START + seconds * 1_000, localMinutes, localDay }
}

/** A random source that returns the values in order, then repeats the last one. */
function sequence(...values: number[]) {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

/** A random source of 0.5: no threshold jitter, and every turn gets a hint. */
const middle = () => 0.5

/** Runs decisions each second from `from` to `to` seconds and returns the first turn. */
function firstTurn(state: InitiativeState, options: InitiativeOptions, from: number, to: number, random = middle) {
  let current = state
  for (let second = from; second <= to; second++) {
    const result = decideInitiative(current, IDLE, at(second), random, options)
    current = result.state
    if (result.decision.kind === 'turn')
      return { second, state: current, decision: result.decision }
  }
  return undefined
}

/** A state with a pending turn that started at `seconds`. */
function withTurn(options: InitiativeOptions, seconds = 900) {
  const result = decideInitiative(createInitiativeState(at(0)), IDLE, at(seconds), middle, options)
  expect(result.decision.kind).toBe('turn')
  return result.state
}

describe('initiative options', () => {
  it('keeps the defaults of the values that the settings omit', () => {
    const options = resolveInitiativeOptions({ modes: { idle: { boredomIntervalMs: 600_000 } }, dailyTurnBudget: 10 })

    expect(options.modes.idle.boredomIntervalMs).toBe(600_000)
    expect(options.modes.idle.refractoryMs).toBe(90_000)
    expect(options.modes.commentary.boredomIntervalMs).toBe(45_000)
    expect(options.dailyTurnBudget).toBe(10)
    expect(options.thresholdJitter).toBe(0.3)
  })

  it('reads local minutes and the local day from a date', () => {
    const time = initiativeTimeFrom(new Date(2026, 9, 29, 7, 30))

    expect(time.localMinutes).toBe(450)
    expect(time.localDay).toBe('2026-10-29')
  })
})

describe('speech pressure', () => {
  const options = resolveInitiativeOptions()

  // With no events, boredom alone starts a turn after one boredom interval at full energy and no jitter.
  it('starts a turn from boredom after one interval of quiet', () => {
    const turn = firstTurn(createInitiativeState(at(0)), options, 0, 1_000)

    // Boredom grows by small floating point steps, so the sum can reach 1 one check late.
    expect(turn?.second).toBeGreaterThanOrEqual(900)
    expect(turn?.second).toBeLessThanOrEqual(901)
    expect(turn?.decision.trigger).toBe('boredom')
  })

  // The lowest jitter draw multiplies the threshold by 0.7.
  // Two intentions add 0.4 drive, so boredom alone needs 0.6 of the interval.
  it('starts a turn sooner with open intentions, and names them as the trigger', () => {
    let state = createInitiativeState(at(0))
    let turn: { second: number, trigger: string } | undefined
    for (let second = 0; second <= 1_000 && !turn; second++) {
      const result = decideInitiative(state, { ...IDLE, intentions: 5 }, at(second), middle, options)
      state = result.state
      if (result.decision.kind === 'turn')
        turn = { second, trigger: result.decision.trigger }
    }

    expect(turn?.second).toBeGreaterThanOrEqual(540)
    expect(turn?.second).toBeLessThanOrEqual(541)
    expect(turn?.trigger).toBe('boredom')

    const fresh = decideInitiative(createInitiativeState(at(0)), { ...IDLE, intentions: 2 }, at(400), middle, resolveInitiativeOptions({ modes: { idle: { boredomIntervalMs: 2_000_000 } } }))
    expect(fresh.decision.kind).toBe('wait')
  })

  it('moves the turn time with the threshold jitter', () => {
    const turn = firstTurn(createInitiativeState(at(0)), options, 0, 1_000, () => 0)

    expect(turn?.second).toBeGreaterThanOrEqual(630)
    expect(turn?.second).toBeLessThanOrEqual(631)
  })

  it('keeps one jitter draw for the whole cycle', () => {
    const first = decideInitiative(createInitiativeState(at(0)), IDLE, at(1), () => 0, options)
    const second = decideInitiative(first.state, IDLE, at(2), () => 0.99, options)

    expect(first.state.jitter).toBeCloseTo(0.7)
    expect(second.state.jitter).toBeCloseTo(0.7)
  })

  it('halves event pressure in one half-life', () => {
    const state = observeInitiative(createInitiativeState(at(0)), { type: 'perceived', salience: 1 }, at(0), options)
    const later = decideInitiative(state, IDLE, at(60), middle, options)

    expect(state.pressure).toBeCloseTo(0.8)
    expect(later.state.pressure).toBeCloseTo(0.4)
  })

  // Many small screen changes must not keep the character talking about the screen.
  it('counts salience squared', () => {
    const small = observeInitiative(createInitiativeState(at(0)), { type: 'perceived', salience: 0.2 }, at(0), options)

    expect(small.pressure).toBeCloseTo(0.032)
  })

  it('starts an event turn when a salient event and some boredom pass the threshold', () => {
    const bored = decideInitiative(createInitiativeState(at(0)), IDLE, at(300), middle, options).state
    const state = observeInitiative(bored, { type: 'perceived', salience: 1 }, at(300), options)
    const result = decideInitiative(state, IDLE, at(300), middle, options)

    expect(result.decision.kind).toBe('turn')
    expect(result.decision.kind === 'turn' && result.decision.trigger).toBe('event')
  })

  // A commentary mission talks often. Its boredom interval is 45 seconds.
  it('uses the settings of the current mode', () => {
    const state = observeInitiative(createInitiativeState(at(0)), { type: 'mode-changed', mode: 'commentary' }, at(0), options)
    const turn = firstTurn(state, options, 0, 100)

    expect(turn?.second).toBeGreaterThanOrEqual(45)
    expect(turn?.second).toBeLessThanOrEqual(46)
  })

  // An owner message gets a normal reply, so the conversation is not quiet and old pressure does not count.
  it('clears boredom and pressure on an owner message', () => {
    const busy = observeInitiative(createInitiativeState(at(0)), { type: 'perceived', salience: 1 }, at(600), options)
    const state = observeInitiative(busy, { type: 'owner-message' }, at(600), options)

    expect(state.pressure).toBe(0)
    expect(state.inner.boredom).toBe(0)
    expect(state.inner.mood).toBeGreaterThan(0)
  })
})

describe('gates', () => {
  const options = resolveInitiativeOptions({ quietHours: { startMinutes: 23 * 60, endMinutes: 7 * 60 } })
  // An event of salience 0 only moves the state to the time. Boredom is then above any threshold.
  const bored = observeInitiative(createInitiativeState(at(0)), { type: 'perceived', salience: 0 }, at(2_000), options)

  // Owner input always wins, so it hides every other reason.
  it('checks owner input first', () => {
    const result = decideInitiative(bored, { ownerActive: true, speechPlaying: true, turnRunning: true, intentions: 0 }, at(2_000), middle, options)

    expect(result.decision).toEqual({ kind: 'wait', reason: 'owner-active' })
  })

  it('waits the grace time after an owner message', () => {
    const state = observeInitiative(bored, { type: 'owner-message' }, at(2_000), options)

    expect(decideInitiative(state, IDLE, at(2_029), middle, options).decision).toEqual({ kind: 'wait', reason: 'owner-active' })
    expect(decideInitiative(state, IDLE, at(2_030), middle, options).decision).toEqual({ kind: 'wait', reason: 'below-threshold' })
  })

  it('waits while speech plays or another turn runs', () => {
    expect(decideInitiative(bored, { ...IDLE, speechPlaying: true }, at(2_000), middle, options).decision).toEqual({ kind: 'wait', reason: 'speech-playing' })
    expect(decideInitiative(bored, { ...IDLE, turnRunning: true }, at(2_000), middle, options).decision).toEqual({ kind: 'wait', reason: 'turn-running' })
  })

  it('starts no second turn before the first one finishes', () => {
    const state = withTurn(options)

    expect(decideInitiative(state, IDLE, at(3_000), middle, options).decision).toEqual({ kind: 'wait', reason: 'turn-running' })
  })

  it('waits in quiet hours that pass midnight', () => {
    expect(decideInitiative(bored, IDLE, at(2_000, '2026-10-29', 23 * 60 + 30), middle, options).decision).toEqual({ kind: 'wait', reason: 'quiet-hours' })
    expect(decideInitiative(bored, IDLE, at(2_000, '2026-10-29', 6 * 60 + 59), middle, options).decision).toEqual({ kind: 'wait', reason: 'quiet-hours' })
    expect(decideInitiative(bored, IDLE, at(2_000, '2026-10-29', 7 * 60), middle, options).decision.kind).toBe('turn')
  })

  it('waits while the owner asked for quiet, and starts after the quiet time', () => {
    const quiet = resolveInitiativeOptions({ quietUntil: at(3_000).now })

    expect(decideInitiative(bored, IDLE, at(2_999), middle, quiet).decision).toEqual({ kind: 'wait', reason: 'owner-quiet' })
    expect(decideInitiative(bored, IDLE, at(3_000), middle, quiet).decision.kind).toBe('turn')
  })

  // Each decision turn is one model call, also when the model stays silent.
  it('stops at the daily turn budget and starts again on the next day', () => {
    const limited = resolveInitiativeOptions({ dailyTurnBudget: 1 })
    const spent = observeInitiative(withTurn(limited), { type: 'turn-finished', outcome: 'silent' }, at(901), limited)

    expect(decideInitiative(spent, IDLE, at(5_000), middle, limited).decision).toEqual({ kind: 'wait', reason: 'daily-budget' })
    expect(decideInitiative(spent, IDLE, at(5_000, '2026-10-30'), middle, limited).decision.kind).toBe('turn')
  })
})

describe('turn results', () => {
  const options = resolveInitiativeOptions()

  it('rests after speech: no pressure, no boredom, less energy, and a refractory time', () => {
    const pending = withTurn(options)
    const state = observeInitiative(pending, { type: 'turn-finished', outcome: 'spoke' }, at(905), options)

    expect(state.turn).toBeUndefined()
    expect(state.pressure).toBe(0)
    expect(state.inner.boredom).toBe(0)
    expect(state.inner.energy).toBeLessThan(1)
    expect(state.refractoryUntil).toBe(at(995).now)
    expect(state.recentTypes).toEqual([pending.turn?.speechType])
  })

  // Silence lowers the drive only in part, so the character tries again sooner than after speech.
  it('keeps half of the drive after a silent choice', () => {
    const pending = withTurn(options)
    const state = observeInitiative(pending, { type: 'turn-finished', outcome: 'silent' }, at(900), options)

    expect(state.inner.boredom).toBeCloseTo(pending.inner.boredom / 2)
    expect(state.recentTypes).toEqual([])
    expect(state.refractoryUntil).toBe(at(990).now)
  })

  // The newer event that made the speech stale needs a reaction, so no refractory time follows.
  it('keeps the drive and adds no refractory time after a dropped turn', () => {
    const pending = withTurn(options)
    const state = observeInitiative(pending, { type: 'turn-finished', outcome: 'dropped' }, at(900), options)

    expect(state.inner.boredom).toBeCloseTo(pending.inner.boredom)
    expect(state.refractoryUntil).toBe(pending.refractoryUntil)
  })

  // The owner did not react to autonomous lines, so idle talk slows down. A reply returns the pace.
  it('makes the idle interval longer after each line without an owner reaction', () => {
    const spoke = observeInitiative(withTurn(options), { type: 'turn-finished', outcome: 'spoke' }, at(905), options)
    expect(spoke.unanswered).toBe(1)

    const afterQuiet = observeInitiative(spoke, { type: 'perceived', salience: 0 }, at(905 + 900), options)
    expect(afterQuiet.inner.boredom).toBeCloseTo(1 / unansweredIntervalFactor(1))

    const answered = observeInitiative(spoke, { type: 'owner-message' }, at(906), options)
    expect(answered.unanswered).toBe(0)
  })

  it('caps the interval factor of lines without a reaction', () => {
    expect(unansweredIntervalFactor(0)).toBe(1)
    expect(unansweredIntervalFactor(2)).toBeCloseTo(1.69)
    expect(unansweredIntervalFactor(20)).toBe(3)
  })

  it('keeps the pace of commentary after lines without a reaction', () => {
    const commentary = { ...createInitiativeState(at(0), 'commentary'), unanswered: 4 }
    const later = observeInitiative(commentary, { type: 'perceived', salience: 0 }, at(45), options)

    expect(later.inner.boredom).toBeCloseTo(1)
  })

  it('draws a new jitter for the next cycle', () => {
    const state = observeInitiative(withTurn(options), { type: 'turn-finished', outcome: 'spoke' }, at(905), options)

    expect(state.jitter).toBeUndefined()
  })

  it('ignores a result without a pending turn', () => {
    const state = createInitiativeState(at(0))

    expect(observeInitiative(state, { type: 'turn-finished', outcome: 'spoke' }, at(0), options)).toBe(state)
  })

  // The first draw is the jitter, and the second decides the hintless share.
  it('gives no hint in the hintless share of turns', () => {
    const quietLong = decideInitiative(createInitiativeState(at(0)), IDLE, at(2_000), sequence(0.5, 0.1, 0.5), options)

    expect(quietLong.decision.kind).toBe('turn')
    expect(quietLong.decision.kind === 'turn' && quietLong.decision.speechType).toBeUndefined()
    expect(quietLong.state.turn?.speechType).toBeUndefined()
  })
})

describe('stale speech', () => {
  const options = resolveInitiativeOptions()

  it('is stale after a salient event that came after the decision', () => {
    const state = observeInitiative(withTurn(options), { type: 'perceived', salience: 0.9 }, at(902), options)

    expect(isSpeechStale(state, IDLE)).toBe(true)
  })

  it('is not stale after a small event', () => {
    const state = observeInitiative(withTurn(options), { type: 'perceived', salience: 0.3 }, at(902), options)

    expect(isSpeechStale(state, IDLE)).toBe(false)
  })

  it('is not stale for the event that caused the turn', () => {
    const bored = decideInitiative(createInitiativeState(at(0)), IDLE, at(300), middle, options).state
    const excited = observeInitiative(bored, { type: 'perceived', salience: 1 }, at(300), options)
    const decided = decideInitiative(excited, IDLE, at(301), middle, options)

    expect(decided.decision.kind).toBe('turn')
    expect(isSpeechStale(decided.state, IDLE)).toBe(false)
  })

  // Owner input always wins over the character's own speech.
  it('is stale when the owner is active or sent a message', () => {
    const pending = withTurn(options)

    expect(isSpeechStale(pending, { ownerActive: true })).toBe(true)
    expect(isSpeechStale(observeInitiative(pending, { type: 'owner-message' }, at(901), options), IDLE)).toBe(true)
  })

  it('is never stale without a pending turn', () => {
    expect(isSpeechStale(createInitiativeState(at(0)), { ownerActive: true })).toBe(false)
  })
})

describe('readout', () => {
  const options = resolveInitiativeOptions()

  it('shows the drive parts and the threshold before the jitter is drawn', () => {
    const readout = initiativeReadout(createInitiativeState(at(0)), { ...IDLE, intentions: 1 }, at(450), options)

    expect(readout.waitReason).toBe('below-threshold')
    expect(readout.drive.boredom).toBeCloseTo(0.5)
    expect(readout.drive.intention).toBeCloseTo(0.2)
    expect(readout.drive.total).toBeCloseTo(0.7)
    expect(readout.threshold).toBe(1)
    expect(readout.jitterDrawn).toBe(false)
  })

  // The inspector must show the same values that the next decision uses.
  it('matches the drive and the threshold of the decision at the same time', () => {
    const result = decideInitiative(createInitiativeState(at(0)), IDLE, at(900), sequence(0.1, 0.5), options)
    if (result.decision.kind !== 'turn')
      throw new Error('expected a turn')
    const readout = initiativeReadout(createInitiativeState(at(0)), IDLE, at(900), options)

    expect(readout.drive.total).toBeCloseTo(result.decision.drive)
    expect(readout.waitReason).toBeUndefined()
    expect(initiativeReadout(result.state, IDLE, at(900), options)).toMatchObject({ waitReason: 'turn-running', jitterDrawn: true, threshold: result.decision.threshold })
  })

  it('shows the gate, the refractory time, the budget, and the interval factor after a spoken line', () => {
    const spoke = observeInitiative(withTurn(options), { type: 'turn-finished', outcome: 'spoke' }, at(901), options)
    const readout = initiativeReadout(spoke, IDLE, at(911), options)

    expect(readout).toMatchObject({ waitReason: 'refractory', refractoryLeftMs: 80_000, unanswered: 1, budget: { turns: 1, limit: 200 } })
    expect(readout.intervalFactor).toBeCloseTo(1.3)
    expect(initiativeReadout(spoke, { ...IDLE, ownerActive: true }, at(911), options).waitReason).toBe('owner-active')
  })
})
