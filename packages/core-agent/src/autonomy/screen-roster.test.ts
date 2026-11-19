import type { RosterWatch } from './screen-roster'

import { describe, expect, it } from 'vitest'

import { EMPTY_ROSTER_WATCH, observeRosterLook, SCREEN_LOOK_QUESTIONS, SCREEN_ROSTER, startRosterRead } from './screen-roster'

const STEP = 2_000

/** Runs looks one step apart. The host starts each read that the watch wants. */
function run(probabilities: readonly number[], castAt?: (at: number, reads: number) => number | undefined) {
  let watch: RosterWatch = EMPTY_ROSTER_WATCH
  const readsAt: number[] = []
  for (const [index, probability] of probabilities.entries()) {
    const at = (index + 1) * STEP
    const cast = castAt?.(at, readsAt.length)
    const observed = observeRosterLook(watch, { at, probability, ...(cast !== undefined ? { castAt: cast } : {}) })
    watch = observed.watch
    if (observed.wanted) {
      watch = startRosterRead(watch, at)
      readsAt.push(at)
    }
  }
  return readsAt
}

describe('roster watch', () => {
  it('asks the react question and the roster question in one request', () => {
    expect(Object.keys(SCREEN_LOOK_QUESTIONS)).toEqual(['react', 'roster', 'iconList'])
  })

  // A scoreboard shows each character by an icon. A read of it has no name to copy.
  it('wants no read for a list that shows the characters by icons', () => {
    const scoreboard = { at: STEP, probability: 0.9, iconList: SCREEN_ROSTER.iconListLimit }

    expect(observeRosterLook(EMPTY_ROSTER_WATCH, scoreboard)).toEqual({ watch: EMPTY_ROSTER_WATCH, wanted: false })
    expect(observeRosterLook(EMPTY_ROSTER_WATCH, { ...scoreboard, iconList: 0.1 }).wanted).toBe(true)
  })

  it('wants no read while the screen shows the play', () => {
    expect(run([0.1, 0.32, 0.05, 0.69])).toEqual([])
  })

  it('reads a roster screen once when the read writes the cast', () => {
    // The cast is written one second after the first read starts.
    const readsAt = run([0.1, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9], (at, reads) => reads && at > 2 * STEP ? 2 * STEP + 1_000 : undefined)

    expect(readsAt).toEqual([2 * STEP])
  })

  it('reads again after its gap when the first read wrote no cast, and then stops', () => {
    const readsAt = run(Array.from<number>({ length: 20 }).fill(0.9))

    expect(readsAt).toEqual([STEP, STEP + SCREEN_ROSTER.minReadGapMs])
    expect(readsAt).toHaveLength(SCREEN_ROSTER.maxReadsPerScreen)
  })

  it('wants no read when a reply wrote the cast after the roster screen appeared', () => {
    expect(run([0.9, 0.9, 0.9], () => STEP)).toEqual([])
  })

  // A cast of the match before must not stop the read of the screen before the next match.
  it('reads a roster screen although an older cast exists', () => {
    expect(run([0.1, 0.9], () => 500)).toEqual([2 * STEP])
  })

  it('keeps one roster screen through one low look', () => {
    const readsAt = run([0.9, 0.9, 0.3, 0.9, 0.9, 0.9, 0.9], (at, reads) => reads ? STEP + 500 : undefined)

    expect(readsAt).toEqual([STEP])
  })

  it('reads again when a roster screen comes back after it was gone', () => {
    const low = Array.from<number>({ length: SCREEN_ROSTER.leaveLooks }).fill(0.1)
    const readsAt = run([0.9, 0.9, ...low, 0.9, 0.9], (at, reads) => reads ? STEP + 500 : undefined)

    expect(readsAt).toEqual([STEP, (3 + SCREEN_ROSTER.leaveLooks) * STEP])
  })

  it('counts no read while no roster screen shows', () => {
    expect(startRosterRead(EMPTY_ROSTER_WATCH, 1_000)).toBe(EMPTY_ROSTER_WATCH)
  })
})
