import type { Scenario } from './simulation'

import { describe, expect, it } from 'vitest'

import { resolveInitiativeOptions } from './initiative'
import { randomEvents, runScenario } from './simulation'

const HOUR = 3_600_000
const options = resolveInitiativeOptions()

/**
 * These cases are the synthetic evaluation of ADR 2026-10-28, Step 0.
 * Each case runs the policy on a fixed event stream and checks the metrics against the behavior that the owner wants.
 */
describe('initiative evaluation with synthetic events', () => {
  it('talks now and then at a desk with no events, at varied gaps', () => {
    const { metrics } = runScenario({ name: 'quiet desk', durationMs: 2 * HOUR, events: [], ownerActivity: [] }, options, 1)

    // The idle boredom interval is 15 minutes. The owner never reacts, so the interval grows after each line, and
    // 2 hours hold about 5 turns.
    expect(metrics.turnsPerMinute).toBeGreaterThan(1 / 40)
    expect(metrics.turnsPerMinute).toBeLessThan(1 / 8)
    expect(metrics.gapVariation).toBeGreaterThan(0.1)
    expect(metrics.silenceShare).toBeGreaterThan(0.98)
  })

  // Implicit feedback: an owner who never reacts hears less and less.
  it('talks less and less to an owner who does not react', () => {
    const { turns } = runScenario({ name: 'no reaction', durationMs: 4 * HOUR, events: [], ownerActivity: [] }, options, 7)
    const spokenAt = turns.filter(turn => turn.outcome === 'spoke').map(turn => turn.at)
    const gaps = spokenAt.slice(1).map((at, index) => at - spokenAt[index]!)

    // The interval grows to 3 times its setting, so the last gaps are about twice the first one or more.
    expect(gaps.length).toBeGreaterThan(2)
    expect(gaps.at(-1)).toBeGreaterThan(gaps[0]! * 1.5)
  })

  // The first trial talked about the screen without end. Many small changes must not do that.
  it('stays mostly silent while the screen changes a little all the time', () => {
    const events = randomEvents({ seed: 2, from: 0, to: HOUR, perMinute: 6, salience: { min: 0.05, max: 0.35 } })
    const { metrics } = runScenario({ name: 'busy screen', durationMs: HOUR, events, ownerActivity: [] }, options, 2)

    expect(metrics.spokenPerMinute).toBeLessThan(1 / 4)
    expect(metrics.silenceShare).toBeGreaterThan(0.97)
  })

  it('reacts to salient events in idle mode more often than to quiet time alone', () => {
    const events = randomEvents({ seed: 3, from: 0, to: HOUR, perMinute: 0.5, salience: { min: 0.8, max: 1 } })
    const salient = runScenario({ name: 'salient events', durationMs: HOUR, events, ownerActivity: [] }, options, 3)
    const quiet = runScenario({ name: 'quiet desk', durationMs: HOUR, events: [], ownerActivity: [] }, options, 3)

    expect(salient.metrics.turnsPerMinute).toBeGreaterThan(quiet.metrics.turnsPerMinute)
    expect(salient.turns.filter(turn => turn.trigger === 'event').length).toBeGreaterThan(0)
  })

  // Owner input always wins.
  it('never starts a turn while the owner talks or in the grace time after it', () => {
    const ownerActivity = Array.from({ length: 30 }, (_, index) => ({ from: index * 120_000, to: index * 120_000 + 50_000 }))
    const events = randomEvents({ seed: 4, from: 0, to: HOUR, perMinute: 2, salience: { min: 0.5, max: 1 } })
    const scenario: Scenario = { name: 'owner chats', durationMs: HOUR, mode: 'commentary', events, ownerActivity }
    const { turns, metrics } = runScenario(scenario, options, 4)

    expect(metrics.gateBreaks).toBe(0)
    for (const turn of turns) {
      const owner = ownerActivity.find(activity => activity.from <= turn.at && turn.at < activity.to + options.ownerGraceMs)
      expect(owner).toBeUndefined()
    }
  })

  it('comments on a game often, reacts to most salient events, and varies its speech types', () => {
    const events = [
      ...randomEvents({ seed: 5, from: 0, to: HOUR, perMinute: 6, salience: { min: 0.05, max: 0.4 } }),
      ...randomEvents({ seed: 6, from: 0, to: HOUR, perMinute: 1, salience: { min: 0.6, max: 1 } }),
    ]
    const { metrics } = runScenario({ name: 'game commentary', durationMs: HOUR, mode: 'commentary', events, ownerActivity: [] }, options, 5)

    expect(metrics.spokenPerMinute).toBeGreaterThan(0.5)
    expect(metrics.spokenPerMinute).toBeLessThan(3)
    expect(metrics.reactedShare).toBeGreaterThan(0.8)
    expect(metrics.speechTypeEntropy).toBeGreaterThan(0.8)
    expect(metrics.longestTypeRun).toBeLessThanOrEqual(3)
    expect(metrics.gateBreaks).toBe(0)
  })

  it('keeps to quiet hours and the daily turn budget over a full day', () => {
    const limited = resolveInitiativeOptions({
      dailyTurnBudget: 20,
      quietHours: { startMinutes: 23 * 60, endMinutes: 7 * 60 },
      modes: { idle: { boredomIntervalMs: 10 * 60_000 } },
    })
    const scenario: Scenario = { name: 'full day', durationMs: 24 * HOUR, tickMs: 5_000, startMinutes: 0, events: [], ownerActivity: [] }
    const { turns } = runScenario(scenario, limited, 6)

    expect(turns.length).toBe(20)
    for (const turn of turns)
      expect(turn.at).toBeGreaterThanOrEqual(7 * HOUR)
  })

  it('gives the same result for the same seed and a different one for another seed', () => {
    const events = randomEvents({ seed: 7, from: 0, to: HOUR, perMinute: 3, salience: { min: 0, max: 1 } })
    const scenario: Scenario = { name: 'mixed', durationMs: HOUR, mode: 'commentary', events, ownerActivity: [] }

    expect(runScenario(scenario, options, 8)).toEqual(runScenario(scenario, options, 8))
    expect(runScenario(scenario, options, 9).turns).not.toEqual(runScenario(scenario, options, 8).turns)
  })
})
