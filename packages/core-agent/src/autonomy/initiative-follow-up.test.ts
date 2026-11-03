import type { InitiativeHost, InitiativeOptions, InitiativeState, InitiativeTime, TurnNext } from './initiative'

import { describe, expect, it } from 'vitest'

import { createInitiativeState, decideInitiative, FOLLOW_UP_LIMITS, initiativeReadout, observeInitiative, resolveInitiativeOptions } from './initiative'

const START = Date.UTC(2026, 9, 29, 1, 0)
const IDLE: InitiativeHost = { ownerActive: false, speechPlaying: false, turnRunning: false, intentions: 0 }
const middle = () => 0.5

function at(seconds: number): InitiativeTime {
  return { now: START + seconds * 1_000, localMinutes: 600, localDay: '2026-10-29' }
}

/** A state where the line of a turn at `seconds` ended with `next`. The random source picks the lowest pause. */
function spokeAt(state: InitiativeState, options: InitiativeOptions, seconds: number, next?: TurnNext) {
  const turn = decideInitiative(state, IDLE, at(seconds), middle, options)
  expect(turn.decision.kind).toBe('turn')
  return observeInitiative(turn.state, { type: 'turn-finished', outcome: 'spoke', ...(next ? { next } : {}) }, at(seconds + 1), options, () => 0)
}

const options = resolveInitiativeOptions({ maxContinuations: 2 })
const pause = FOLLOW_UP_LIMITS.continuationPauseMs.min / 1_000
const wait = FOLLOW_UP_LIMITS.ownerAnswerWaitMs.min / 1_000

describe('follow-up turns', () => {
  it('goes on after a short pause from the end of the speech, past the refractory time', () => {
    const spoke = spokeAt(createInitiativeState(at(0)), options, 900, 'continue')
    // The speech plays for 20 seconds, and the pause counts from its end.
    const ended = observeInitiative(spoke, { type: 'speech-ended' }, at(921), options)

    expect(decideInitiative(ended, IDLE, at(921 + pause - 1), middle, options).decision).toEqual({ kind: 'wait', reason: 'refractory' })
    expect(decideInitiative(ended, IDLE, at(921 + pause), middle, options).decision).toMatchObject({ kind: 'turn', trigger: 'continuation' })
  })

  it('stops going on at the limit of continuations, until the owner writes', () => {
    let state = spokeAt(createInitiativeState(at(0)), options, 900, 'continue')
    let second = 901
    // Two continuations follow, each ending with continue again.
    for (let index = 0; index < 2; index++) {
      second += pause
      const result = decideInitiative(state, IDLE, at(second), middle, options)
      expect(result.decision).toMatchObject({ kind: 'turn', trigger: 'continuation' })
      second += 1
      state = observeInitiative(result.state, { type: 'turn-finished', outcome: 'spoke', next: 'continue' }, at(second), options, () => 0)
    }
    expect(state.continuations).toBe(2)
    expect(state.followUp).toBeUndefined()

    expect(observeInitiative(state, { type: 'owner-message' }, at(second + 1), options).continuations).toBe(0)
  })

  it('nudges once after a wait without an answer, and not again until the owner writes', () => {
    const spoke = spokeAt(createInitiativeState(at(0)), options, 900, 'wait')

    expect(decideInitiative(spoke, IDLE, at(901 + wait - 1), middle, options).decision.kind).toBe('wait')
    const nudge = decideInitiative(spoke, IDLE, at(901 + wait), middle, options)
    expect(nudge.decision).toMatchObject({ kind: 'turn', trigger: 'follow-up' })

    const waitedAgain = observeInitiative({ ...nudge.state, continuations: 2 }, { type: 'turn-finished', outcome: 'spoke', next: 'wait' }, at(901 + wait + 1), options, () => 0)
    expect(waitedAgain.followUp).toBeUndefined()
    // ROOT CAUSE:
    // A wait after the used nudge kept the count of an earlier chain, so a later continue never went on until the
    // owner wrote. A wait hands the talk to the owner, so it now starts the count again.
    expect(waitedAgain.continuations).toBe(0)
  })

  it('drops the follow-up when the owner writes, and keeps every gate but the refractory time', () => {
    const spoke = spokeAt(createInitiativeState(at(0)), options, 900, 'continue')

    expect(decideInitiative(spoke, { ...IDLE, ownerActive: true }, at(901 + pause), middle, options).decision).toEqual({ kind: 'wait', reason: 'owner-active' })
    expect(observeInitiative(spoke, { type: 'owner-message' }, at(902), options).followUp).toBeUndefined()
  })

  it('shows the follow-up and the count in the readout', () => {
    const spoke = spokeAt(createInitiativeState(at(0)), options, 900, 'continue')

    expect(initiativeReadout(spoke, IDLE, at(902), options)).toMatchObject({ followUp: { kind: 'continuation', dueInMs: (pause - 1) * 1_000 }, continuations: 1 })
  })

  it('makes a done line start the count again, and a line without a marker get no follow-up', () => {
    const done = spokeAt({ ...createInitiativeState(at(0)), continuations: 2 }, options, 900, 'done')
    expect(done.continuations).toBe(0)
    expect(done.followUp).toBeUndefined()

    expect(spokeAt(createInitiativeState(at(0)), options, 900).followUp).toBeUndefined()
  })
})
