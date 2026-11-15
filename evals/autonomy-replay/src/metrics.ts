import type { ReplayResult } from './replay'

import { bigramSimilarity, distinctN, speechTypeEntropy } from '@proj-airi/core-agent'

/** What the judge said about one line. */
export interface LineJudgment {
  /** The line refers to something that the screen shows in its window. */
  readonly grounded: boolean
  /** The line contradicts the timeline. */
  readonly contradicts: boolean
  /** The count of proper names in the line: characters, skills, and items. */
  readonly names?: number
  /** The count of those names that are wrong for the scene. */
  readonly wrongNames?: number
}

/**
 * A score in a line, for example "24対25", "3-2", or "12 to 11". A clock like "5:23" is no score, so a colon does not
 * count. Full-width digits count after the text is normalized.
 */
const SCORE = /\d+\s*(?:対|-|vs\.?|to)\s*\d+/i

/**
 * When a line counts as a repeat: its similarity with one of the lines before it, on the scale of `bigramSimilarity`.
 * The value is a first guess. Lines with the same words in another order reach about 0.6.
 */
const REPEAT = {
  similarity: 0.6,
  /** The notice of a turn shows the model this many of its last lines, so a repeat of one of them is a failure. */
  lookback: 3,
} as const

/**
 * The value that `share` of the sorted values stay at or under, by the nearest rank.
 *
 * @example
 * percentile([900, 1000, 1100, 4000], 0.5)
 * // => 1000
 */
function percentile(values: readonly number[], share: number) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)]
}

/** The metrics of the ADR for one replay. Shares are from 0 to 1, and a missing value had nothing to measure. */
export interface ReplayMetrics {
  readonly turnsPerMinute: number
  readonly silenceShare: number
  readonly distinct2: number
  readonly typeEntropy: number
  readonly imagesPerHour: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedTokens: number
  readonly cacheShare: number
  /** The input tokens of all turns for each spoken line, so silent turns count as cost of the lines. */
  readonly inputTokensPerLine?: number
  /** The model requests for each turn. Above 1 means tool calls, and each one adds a request before the line. */
  readonly requestsPerTurn: number
  readonly toolCalls: number
  /** The share of turns where the model wrote on after the end marker of its reply. The chat runtime dropped that text. */
  readonly cutShare: number
  /** The share of lines without an end marker. What the model writes after such a line reaches the speech. */
  readonly missingEndShare?: number
  /** The median time from the start of a request to the first text of a line, in milliseconds. */
  readonly firstTextMsMedian?: number
  /** The time that 9 of 10 lines stay under. The slow lines are what the owner notices. */
  readonly firstTextMsSlow?: number
  /** The share of lines that are close to one of the three lines before them. */
  readonly repeatShare?: number
  /** The output tokens of all turns for each spoken line. A line of some sentences needs under 200. */
  readonly outputTokensPerLine?: number
  /** The median length of a line in characters. */
  readonly lineCharsMedian?: number
  /**
   * The length of the longest line in characters. A model that does not stop writes thousands, and its speech holds
   * every later turn of the replay.
   */
  readonly lineCharsMax?: number
  /** The mean similarity of consecutive lines. Too high means a stuck topic, too low a jump without a link. */
  readonly topicSimilarity?: number
  readonly groundedShare?: number
  readonly contradictionShare?: number
  /** The share of lines that say a score. A high share means that the character reads the scoreboard aloud. */
  readonly scoreShare?: number
  /** The share of judged lines that name a character, a skill, or an item. */
  readonly namedShare?: number
  /** The share of judged lines with a wrong name. */
  readonly wrongNameShare?: number
}

/** Measures one replay, with the judgments of its lines when the judge ran. */
export function replayMetrics(result: ReplayResult, judgments: readonly LineJudgment[] = []): ReplayMetrics {
  const minutes = result.durationMs / 60_000
  const texts = result.lines.map(line => line.text)
  const pairs = texts.slice(1).map((text, index) => bigramSimilarity(texts[index], text))
  const types = result.lines.flatMap(line => line.speechType ? [line.speechType] : [])
  const firstTexts = result.lines.flatMap(line => line.firstTextMs !== undefined ? [line.firstTextMs] : [])
  const repeats = texts.filter((text, index) => texts.slice(Math.max(0, index - REPEAT.lookback), index).some(earlier => bigramSimilarity(earlier, text) >= REPEAT.similarity))
  return {
    turnsPerMinute: minutes > 0 ? result.turns / minutes : 0,
    silenceShare: result.turns ? result.silent / result.turns : 0,
    distinct2: distinctN(texts, 2),
    typeEntropy: speechTypeEntropy(types),
    imagesPerHour: minutes > 0 ? result.images / (minutes / 60) : 0,
    inputTokens: result.usage.input,
    outputTokens: result.usage.output,
    cachedTokens: result.usage.cached,
    cacheShare: result.usage.input ? result.usage.cached / result.usage.input : 0,
    ...(texts.length
      ? {
          inputTokensPerLine: result.usage.input / texts.length,
          outputTokensPerLine: result.usage.output / texts.length,
          repeatShare: repeats.length / texts.length,
          lineCharsMedian: percentile(texts.map(text => text.length), 0.5),
          lineCharsMax: Math.max(...texts.map(text => text.length)),
          missingEndShare: result.missingEnd / texts.length,
          scoreShare: texts.filter(text => SCORE.test(text.normalize('NFKC'))).length / texts.length,
        }
      : {}),
    requestsPerTurn: result.turns ? result.requests / result.turns : 0,
    toolCalls: result.toolCalls,
    cutShare: result.turns ? result.cuts / result.turns : 0,
    ...(firstTexts.length ? { firstTextMsMedian: percentile(firstTexts, 0.5), firstTextMsSlow: percentile(firstTexts, 0.9) } : {}),
    ...(pairs.length ? { topicSimilarity: pairs.reduce((sum, value) => sum + value, 0) / pairs.length } : {}),
    ...(judgments.length
      ? {
          groundedShare: judgments.filter(judgment => judgment.grounded).length / judgments.length,
          contradictionShare: judgments.filter(judgment => judgment.contradicts).length / judgments.length,
          namedShare: judgments.filter(judgment => (judgment.names ?? 0) > 0).length / judgments.length,
          wrongNameShare: judgments.filter(judgment => (judgment.wrongNames ?? 0) > 0).length / judgments.length,
        }
      : {}),
  }
}
