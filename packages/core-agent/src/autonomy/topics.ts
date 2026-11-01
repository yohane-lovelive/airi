import type { SpeechType } from './speech-types'

import { SPEECH_TYPES } from './speech-types'

/** Limits of topic labels, threads, and seeds. The notice and the inspector read them. */
export const TOPIC_LIMITS = {
  /** A topic label is cut to this length. A label names a topic in a few words. */
  maxLabelLength: 40,
  /** Each turn offers at most this many seeds. */
  seedCount: 3,
  /** Each seed is cut to this length, so the situation block stays near its budget. */
  maxSeedLength: 80,
  /** Seeds avoid the topics of this many recent days. */
  recentDays: 3,
  /** Two consecutive lines with this similarity or more belong to one thread. */
  threadSimilarity: 0.5,
  /** Each line that the owner answered multiplies the heat of its thread by this value. */
  answeredHeatStep: 0.85,
  /** Each line without an owner answer multiplies the heat by this value, so a thread without answers cools fast. */
  unansweredHeatStep: 0.55,
  /** A thread at this heat or less is cold. The notice asks for a new topic. */
  coldHeat: 0.35,
  /** A seed with this similarity or more to a recent topic is not offered. */
  staleSeedSimilarity: 0.6,
  /**
   * A seed that a spoken turn offered rests for this time. The similarity misses a seed in another language than the
   * lines, for example an English calendar seed and a Japanese line, so the rest keeps it from coming back each turn.
   */
  seedRestMs: 6 * 60 * 60_000,
} as const

/**
 * How near two topics are, from 0 to 1. A thread, the novelty of seeds, and the variety measures use it.
 * The host can pass another one, for example a similarity of embeddings.
 */
export type TopicSimilarity = (left: string, right: string) => number

/**
 * The pairs of neighbor characters in a text, without spaces and case. Japanese has no spaces, so words do not work.
 * A one-character text gives that character, so a short query still matches.
 */
export function characterBigrams(text: string): Set<string> {
  const compact = text.toLowerCase().replace(/\s+/g, '')
  const bigrams = new Set<string>()
  for (let index = 0; index < compact.length - 1; index++)
    bigrams.add(compact.slice(index, index + 2))
  if (compact.length === 1)
    bigrams.add(compact)
  return bigrams
}

/**
 * The share of character pairs that two topics have in common (the Dice coefficient).
 *
 * NOTICE:
 * The ADR compares topic labels by their embeddings. The client has no text embeddings yet.
 * Character pairs find shared words, but not a paraphrase, for example "ラーメン" and "麺類".
 * Source: docs/ai/adr/2026-10-28-autonomous-character-perception-and-missions.md, section "Small talk".
 * Removal condition: the memory ADR adds text embeddings. Then the host passes an embedding similarity, and this
 * function stays only as the fallback without embeddings.
 *
 * @example
 * bigramSimilarity('ラーメン屋', 'ラーメン')
 * // => 0.857...
 */
export function bigramSimilarity(left: string, right: string): number {
  const leftPairs = characterBigrams(left)
  const rightPairs = characterBigrams(right)
  if (!leftPairs.size || !rightPairs.size)
    return 0
  let shared = 0
  for (const pair of leftPairs) {
    if (rightPairs.has(pair))
      shared += 1
  }
  return (2 * shared) / (leftPairs.size + rightPairs.size)
}

const TOPIC_MARKER = /^<\|TOPIC\s([\s\S]*)\|>$/

/**
 * Reads the label of a `<|TOPIC ...|>` marker. Returns `undefined` for another marker or an empty label.
 *
 * @example
 * topicFromMarker('<|TOPIC 週末の予定|>')
 * // => '週末の予定'
 */
export function topicFromMarker(special: string): string | undefined {
  const label = TOPIC_MARKER.exec(special.trim())?.[1]?.replace(/\s+/g, ' ').trim()
  if (!label)
    return undefined
  return label.length > TOPIC_LIMITS.maxLabelLength ? label.slice(0, TOPIC_LIMITS.maxLabelLength) : label
}

/** One line that the character started on its own. */
export interface TopicLine {
  /** The spoken text. */
  readonly text: string
  /** The topic label that the model wrote. Older lines have none. */
  readonly label?: string
  /** Epoch milliseconds. */
  readonly at: number
  /** Whether the owner wrote after this line and before the next autonomous line. */
  readonly answered: boolean
}

/** The topic of a line: its label, or its text when it has no label. */
export function topicOf(line: TopicLine): string {
  return line.label ?? line.text
}

/** The thread that the newest lines follow. */
export interface TopicThread {
  /** The topic of the newest line of the thread. */
  readonly topic: string
  /** The count of lines in the thread. */
  readonly lines: number
  /** 1 for a new thread. Each line lowers it, and a line without an answer lowers it more. */
  readonly heat: number
  readonly cold: boolean
}

/**
 * Finds the thread of the newest lines: the newest line and the lines before it, while each one is near the next.
 * Returns `undefined` without lines.
 *
 * @example
 * currentTopicThread([{ text: '…', label: 'ラーメン', at: 0, answered: false }])
 * // => { topic: 'ラーメン', lines: 1, heat: 0.55, cold: false }
 */
export function currentTopicThread(lines: readonly TopicLine[], similarity: TopicSimilarity = bigramSimilarity): TopicThread | undefined {
  const newest = lines.at(-1)
  if (!newest)
    return undefined
  let heat = 1
  let count = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    const next = lines[index + 1]
    if (next && similarity(topicOf(line), topicOf(next)) < TOPIC_LIMITS.threadSimilarity)
      break
    heat *= line.answered ? TOPIC_LIMITS.answeredHeatStep : TOPIC_LIMITS.unansweredHeatStep
    count += 1
  }
  return { topic: topicOf(newest), lines: count, heat, cold: heat <= TOPIC_LIMITS.coldHeat }
}

/** Where a seed comes from. */
export type TopicSeedSource = 'memory' | 'calendar'

/** Something that the character can talk about. */
export interface TopicSeed {
  readonly text: string
  readonly source: TopicSeedSource
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Seeds from the calendar of a local day: the month, the day of the week, and the start or end of a month or year.
 * They name the date only, not a season, because the season depends on the hemisphere.
 *
 * @example
 * calendarTopicSeeds('2026-11-01').map(seed => seed.text)
 * // => ['It is November.', 'Today is Sunday, a weekend day.', 'A new month just started.']
 */
export function calendarTopicSeeds(localDay: string): TopicSeed[] {
  const [year, month, day] = localDay.split('-').map(Number)
  if (!year || !month || !day)
    return []
  const weekday = new Date(year, month - 1, day).getDay()
  const daysInMonth = new Date(year, month, 0).getDate()
  const weekend = weekday === 0 || weekday === 6
  const texts = [
    `It is ${MONTHS[month - 1]}.`,
    `Today is ${WEEKDAYS[weekday]}${weekend ? ', a weekend day' : ''}.`,
  ]
  if (month === 1 && day <= 7)
    texts.push('A new year just started.')
  else if (month === 12 && day >= 20)
    texts.push('The year ends soon.')
  else if (day <= 3)
    texts.push('A new month just started.')
  else if (day > daysInMonth - 3)
    texts.push('The month ends soon.')
  return texts.map(text => ({ text, source: 'calendar' }))
}

/** What {@link pickTopicSeeds} reads. */
export interface TopicSeedRequest {
  readonly seeds: readonly TopicSeed[]
  /** The topics of recent lines. A seed near one of them gets a lower weight. */
  readonly recentTopics: readonly string[]
  /** The texts of seeds that rest now. They are not offered. */
  readonly resting?: readonly string[]
  readonly random: () => number
  readonly similarity?: TopicSimilarity
  /** @default TOPIC_LIMITS.seedCount */
  readonly count?: number
}

/**
 * Draws seeds by weight, without repeats. A seed near a recent topic gets a lower weight, and a seed with
 * `staleSeedSimilarity` or more to one is never drawn. A cold thread is a recent topic too, so its seeds go away.
 * A resting seed is never drawn.
 */
export function pickTopicSeeds(request: TopicSeedRequest): TopicSeed[] {
  const similarity = request.similarity ?? bigramSimilarity
  const seen = new Set<string>(request.resting)
  const pool: { seed: TopicSeed, weight: number }[] = []
  for (const seed of request.seeds) {
    const text = seed.text.replace(/\s+/g, ' ').trim()
    if (!text || seen.has(text))
      continue
    seen.add(text)
    const nearest = Math.max(0, ...request.recentTopics.map(topic => similarity(text, topic)))
    if (nearest >= TOPIC_LIMITS.staleSeedSimilarity)
      continue
    // The square makes a seed far from every recent topic much more likely than a near one.
    pool.push({ seed: { ...seed, text }, weight: (1 - nearest) ** 2 })
  }

  const picked: TopicSeed[] = []
  const count = request.count ?? TOPIC_LIMITS.seedCount
  while (picked.length < count && pool.length) {
    const total = pool.reduce((sum, entry) => sum + entry.weight, 0)
    let target = request.random() * total
    // Floating point rounding can leave a small remainder, and the last seed is then the correct bucket.
    let index = pool.length - 1
    for (const [entryIndex, entry] of pool.entries()) {
      target -= entry.weight
      if (target < 0) {
        index = entryIndex
        break
      }
    }
    picked.push(pool[index].seed)
    pool.splice(index, 1)
  }
  return picked
}

/**
 * The share of distinct character n-grams in the texts, from 0 to 1. A low value means repeated phrases.
 * Returns 0 when the texts are too short for one n-gram.
 *
 * @example
 * distinctN(['ねえねえ'], 2)
 * // => 0.666... (2 distinct of 3)
 */
export function distinctN(texts: readonly string[], n = 2): number {
  let total = 0
  const distinct = new Set<string>()
  for (const text of texts) {
    const compact = text.replace(/\s+/g, '')
    for (let index = 0; index + n <= compact.length; index++) {
      distinct.add(compact.slice(index, index + n))
      total += 1
    }
  }
  return total ? distinct.size / total : 0
}

/**
 * The entropy of the speech types, from 0 to 1. 1 means that every type came equally often, and 0 means one type only.
 *
 * @example
 * speechTypeEntropy(['ask', 'ask'])
 * // => 0
 */
export function speechTypeEntropy(types: readonly SpeechType[]): number {
  if (!types.length)
    return 0
  let entropy = 0
  for (const type of SPEECH_TYPES) {
    const share = types.filter(value => value === type).length / types.length
    if (share > 0)
      entropy -= share * Math.log(share)
  }
  return entropy / Math.log(SPEECH_TYPES.length)
}

/** The variety of autonomous lines, for the inspector and for evaluation. */
export interface TopicVariety {
  readonly lines: number
  /** {@link distinctN} with n = 2 over the line texts. */
  readonly distinct2: number
  /** {@link speechTypeEntropy} of the hinted speech types. */
  readonly typeEntropy: number
  /**
   * The mean similarity of consecutive topics. A high value means a stuck topic, and a low value means jumps without a
   * link. Undefined with fewer than two lines.
   */
  readonly topicSimilarity?: number
}

/** Measures the variety of lines and of the speech types of their turns. */
export function topicVariety(lines: readonly TopicLine[], types: readonly SpeechType[], similarity: TopicSimilarity = bigramSimilarity): TopicVariety {
  const pairs = lines.slice(1).map((line, index) => similarity(topicOf(lines[index]), topicOf(line)))
  return {
    lines: lines.length,
    distinct2: distinctN(lines.map(line => line.text), 2),
    typeEntropy: speechTypeEntropy(types),
    ...(pairs.length ? { topicSimilarity: pairs.reduce((sum, value) => sum + value, 0) / pairs.length } : {}),
  }
}
