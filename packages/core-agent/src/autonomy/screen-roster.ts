import type { DecisionQuestion } from '../runtime/recipe'

import { SCREEN_GATE_QUESTION } from './screen-gate'

/**
 * The settings of the roster watch. A roster screen lists the names of who takes part in the scene, for example the
 * loading screen of a match, a character select, or a table of results.
 *
 * The decision model finds such a screen, and the chat model then reads the cast of the scene from it. The screen
 * starts the read, not a moment of the app, so the read works in every game that shows such a screen.
 */
export const SCREEN_ROSTER = {
  /**
   * The chance of yes from which a look shows a roster screen. On a recorded match, the probe of 2026-11-15 gave 0.76
   * to 0.93 for 19 looks at the loading screen, and 0.32 at most for 38 looks at the play.
   */
  threshold: 0.7,
  /** A roster screen is gone after this many looks below the threshold in a row. One low look can be noise. */
  leaveLooks: 2,
  /** The most reads of one roster screen. A second read runs only when the first one wrote no cast. */
  maxReadsPerScreen: 2,
  /** The least time between the starts of two reads, so the cast of the first read is stored before the next look. */
  minReadGapMs: 8_000,
} as const

/**
 * The question that finds a roster screen.
 *
 * It names no game. The words are the ones that the probe measured. A question about every written fact worth
 * keeping gave 0.28 to 0.81 for one loading screen, so this question asks about a list of names only.
 */
export const SCREEN_ROSTER_QUESTION = {
  type: 'noul',
  instructions: '2 枚目（今）の画面は、この場面に参加する人やキャラクターの名前が、一覧として書かれている画面ですか。',
  criteria: {
    true: '参加者の名前が並んで書かれている。例えば、対戦前の紹介や読み込みの画面、キャラクターやチームを選ぶ画面、全員の成績の表、結果の一覧。',
    false: 'プレイ中の画面や、参加者の名前の一覧がない画面。',
  },
} as const satisfies DecisionQuestion

/**
 * The questions of one screen look. One request of the decision model asks them all about the same two frames, so the
 * second question costs no request of its own. The questions cannot see each other.
 */
export const SCREEN_LOOK_QUESTIONS = {
  react: SCREEN_GATE_QUESTION,
  roster: SCREEN_ROSTER_QUESTION,
} as const

/** What the roster watch knows between two looks. */
export interface RosterWatch {
  /** The time of the look that first showed the roster screen that shows now. Missing while no roster screen shows. */
  readonly since?: number
  /** The looks below the threshold in a row, while a roster screen shows. */
  readonly below: number
  /** The reads that started for the roster screen that shows now. */
  readonly reads: number
  /** The start of the last one of these reads. */
  readonly lastReadAt?: number
}

/** The watch before the first look, and after a roster screen is gone. */
export const EMPTY_ROSTER_WATCH: RosterWatch = { below: 0, reads: 0 }

/**
 * Takes one look into the roster watch, and tells whether the chat model must read the cast now.
 *
 * - A read is wanted while a roster screen shows and no cast was written since it appeared.
 * - A roster screen that comes back after it was gone counts as a new one. So the screen before the next match gives
 *   a new cast.
 * - The host starts the read when it is free, and then calls {@link startRosterRead}. A host that is busy asks again
 *   at the next look.
 *
 * @param watch The watch after the look before.
 * @param look The look.
 * @param look.at The time of the current frame of the look.
 * @param look.probability The chance that the frame shows a roster screen.
 * @param look.castAt The time when the cast of the scene was last written.
 */
export function observeRosterLook(watch: RosterWatch, look: { at: number, probability: number, castAt?: number }): { watch: RosterWatch, wanted: boolean } {
  if (look.probability < SCREEN_ROSTER.threshold) {
    if (watch.since === undefined)
      return { watch, wanted: false }
    const below = watch.below + 1
    return { watch: below >= SCREEN_ROSTER.leaveLooks ? EMPTY_ROSTER_WATCH : { ...watch, below }, wanted: false }
  }

  const since = watch.since ?? look.at
  const current: RosterWatch = watch.since === undefined ? { since, below: 0, reads: 0 } : { ...watch, below: 0 }
  const castIsNew = look.castAt !== undefined && look.castAt >= since
  const rested = current.lastReadAt === undefined || look.at - current.lastReadAt >= SCREEN_ROSTER.minReadGapMs
  return { watch: current, wanted: !castIsNew && current.reads < SCREEN_ROSTER.maxReadsPerScreen && rested }
}

/** Counts a read that the host started at `at` for the roster screen that shows now. */
export function startRosterRead(watch: RosterWatch, at: number): RosterWatch {
  return watch.since === undefined ? watch : { ...watch, reads: watch.reads + 1, lastReadAt: at }
}
