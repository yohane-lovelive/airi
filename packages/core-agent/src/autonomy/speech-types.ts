/**
 * The kinds of speech that the character can start on its own.
 *
 * - `react`: comment on something that just happened.
 * - `joke`: say something light or playful.
 * - `ask`: ask the owner a question.
 * - `recall`: bring up a memory or an earlier topic.
 * - `think-aloud`: say a passing thought.
 * - `watch-quietly`: give a short remark, or stay silent.
 */
export const SPEECH_TYPES = ['react', 'joke', 'ask', 'recall', 'think-aloud', 'watch-quietly'] as const

export type SpeechType = typeof SPEECH_TYPES[number]

/**
 * The count of recent speech types that lower the weight of a repeat.
 * The initiative state keeps this many types, newest last.
 */
export const RECENT_SPEECH_TYPE_COUNT = 4

/** What the draw reads. The values come from the initiative state at the decision. */
export interface SpeechTypeContext {
  /** 0 to 1. */
  readonly energy: number
  /** -1 to 1. */
  readonly mood: number
  /** 0 and up. Values above 1 count as 1. */
  readonly boredom: number
  /** 0 to 1. */
  readonly curiosity: number
  /**
   * The share of the drive that came from events, 0 to 1.
   * A turn that an event started favors `react`. A turn that boredom started favors `recall` and `ask`.
   */
  readonly eventShare: number
  /** Speech types of the last spoken turns, newest last. */
  readonly recentTypes: readonly SpeechType[]
}

/**
 * Draws one speech type by weight.
 *
 * Inner state sets the base weights. A type that the character used recently has a lower weight,
 * and the newest one has the lowest. Code owns variety this way, so no second model call picks the type.
 */
export function drawSpeechType(context: SpeechTypeContext, random: () => number): SpeechType {
  const weights = speechTypeWeights(context)
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let target = random() * total
  for (const [index, type] of SPEECH_TYPES.entries()) {
    target -= weights[index]
    if (target < 0)
      return type
  }
  // `random()` returns a value below 1, so the loop returns before here. Floating point rounding can still leave
  // a small remainder, and the last type is then the correct bucket.
  return SPEECH_TYPES[SPEECH_TYPES.length - 1]
}

function speechTypeWeights(context: SpeechTypeContext): number[] {
  const boredom = Math.min(1, context.boredom)
  const quietShare = 1 - context.eventShare
  // Mood -1 to 1 becomes 0 to 2. Energy 0 to 1 becomes 0.5 to 1.5. Both scale the active types.
  const cheer = 1 + context.mood
  const vigor = 0.5 + context.energy

  const base: Record<SpeechType, number> = {
    'react': 0.15 + 2 * context.eventShare,
    'joke': 0.35 * cheer * vigor,
    'ask': (0.25 + 0.4 * context.curiosity + 0.3 * boredom * quietShare) * vigor,
    'recall': 0.1 + 0.6 * boredom * quietShare,
    'think-aloud': 0.3 + 0.25 * Math.max(0, -context.mood) + 0.2 * context.curiosity,
    'watch-quietly': 0.15 + 0.7 * (1 - context.energy),
  }

  return SPEECH_TYPES.map((type) => {
    let weight = base[type]
    for (const [index, recent] of context.recentTypes.entries()) {
      if (recent !== type)
        continue
      // The newest type gets the strongest penalty, so the same type rarely comes twice in a row.
      const newest = index === context.recentTypes.length - 1
      weight *= newest ? 0.2 : 0.6
    }
    return weight
  })
}
