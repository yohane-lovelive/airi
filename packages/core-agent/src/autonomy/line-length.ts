import type { InitiativeMode } from './initiative'

/** How long one autonomous line is. Code draws it, so the lines vary and a long talk can grow. */
export type LineLength = 'short' | 'normal' | 'long'

/** What the length of a line depends on. */
export interface LineLengthContext {
  readonly mode: InitiativeMode
  /** The owner asked for small talk, so the character talks more. */
  readonly smallTalk: boolean
  /** The owner only listens, so the character talks the longest. */
  readonly solo?: boolean
  /** The screen activity of commentary, from 0 to 1. */
  readonly activity?: number
  /** The timeline holds notes, so a calm moment of commentary has something to look back on. */
  readonly hasNotes: boolean
}

/** The share of each length, in the order short, normal, long. */
type LengthWeights = readonly [short: number, normal: number, long: number]

export const LINE_LENGTH_LIMITS = {
  /** From this screen activity on, commentary keeps to quick reactions. */
  activeScreen: 0.5,
  weights: {
    idle: [0.7, 0.3, 0],
    smallTalk: [0.2, 0.5, 0.3],
    soloTalk: [0.1, 0.4, 0.5],
    activeCommentary: [0.8, 0.2, 0],
    calmCommentary: [0.4, 0.4, 0.2],
  } satisfies Record<string, LengthWeights>,
} as const

const LENGTHS: readonly LineLength[] = ['short', 'normal', 'long']

function weightsOf(context: LineLengthContext): LengthWeights {
  const { weights, activeScreen } = LINE_LENGTH_LIMITS
  if (context.mode === 'commentary') {
    if ((context.activity ?? 0) >= activeScreen)
      return weights.activeCommentary
    // A calm moment can look back at length only when the timeline holds something to look back on.
    const [short, normal, long] = weights.calmCommentary
    return context.hasNotes ? weights.calmCommentary : [short, normal + long, 0]
  }
  if (context.solo)
    return weights.soloTalk
  return context.smallTalk ? weights.smallTalk : weights.idle
}

/**
 * Draws the length of one autonomous line.
 *
 * Idle speech stays mostly short. Small talk talks longer. Commentary keeps to quick reactions on a busy screen, and can
 * look back at length in a calm moment.
 *
 * @example
 * drawLineLength({ mode: 'idle', smallTalk: false, hasNotes: false }, () => 0.9)
 * // => 'normal'
 */
export function drawLineLength(context: LineLengthContext, random: () => number): LineLength {
  const weights = weightsOf(context)
  let roll = random() * weights.reduce((sum, weight) => sum + weight, 0)
  for (const [index, weight] of weights.entries()) {
    if (roll < weight)
      return LENGTHS[index]
    roll -= weight
  }
  return 'short'
}

/** The instruction of the notice for a length. */
export const LINE_LENGTH_TEXT: Record<LineLength, string> = {
  short: 'Length: one short sentence.',
  normal: 'Length: two to four sentences.',
  long: 'Length: five to eight sentences, a fuller story or thought. You can put <|DELAY 1|> between thoughts.',
}
