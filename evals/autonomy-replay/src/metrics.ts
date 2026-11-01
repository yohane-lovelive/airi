import type { ReplayResult } from './replay'

import { bigramSimilarity, distinctN, speechTypeEntropy } from '@proj-airi/core-agent'

/** What the judge said about one line. */
export interface LineJudgment {
  /** The line refers to something that the screen shows in its window. */
  readonly grounded: boolean
  /** The line contradicts the timeline. */
  readonly contradicts: boolean
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
  /** The mean similarity of consecutive lines. Too high means a stuck topic, too low a jump without a link. */
  readonly topicSimilarity?: number
  readonly groundedShare?: number
  readonly contradictionShare?: number
}

/** Measures one replay, with the judgments of its lines when the judge ran. */
export function replayMetrics(result: ReplayResult, judgments: readonly LineJudgment[] = []): ReplayMetrics {
  const minutes = result.durationMs / 60_000
  const texts = result.lines.map(line => line.text)
  const pairs = texts.slice(1).map((text, index) => bigramSimilarity(texts[index], text))
  const types = result.lines.flatMap(line => line.speechType ? [line.speechType] : [])
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
    ...(pairs.length ? { topicSimilarity: pairs.reduce((sum, value) => sum + value, 0) / pairs.length } : {}),
    ...(judgments.length
      ? {
          groundedShare: judgments.filter(judgment => judgment.grounded).length / judgments.length,
          contradictionShare: judgments.filter(judgment => judgment.contradicts).length / judgments.length,
        }
      : {}),
  }
}
