import type { TopicLine, TopicSeed } from './topics'

import { describe, expect, it } from 'vitest'

import {
  bigramSimilarity,
  calendarTopicSeeds,
  currentTopicThread,
  distinctN,
  pickTopicSeeds,
  speechTypeEntropy,
  TOPIC_LIMITS,
  topicFromMarker,
  topicVariety,
} from './topics'

function line(label: string | undefined, answered = false, text = label ?? ''): TopicLine {
  return { text, ...(label ? { label } : {}), at: 0, answered }
}

/** A random source that returns the values in order, then repeats the last one. */
function sequence(...values: number[]) {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

describe('bigramSimilarity', () => {
  it('is 1 for the same topic, high for a shared word, and 0 for unrelated topics', () => {
    expect(bigramSimilarity('ラーメン', 'ラーメン')).toBe(1)
    expect(bigramSimilarity('ラーメン屋', 'ラーメン')).toBeCloseTo(6 / 7)
    expect(bigramSimilarity('ラーメン', '週末の予定')).toBe(0)
    expect(bigramSimilarity('', 'ラーメン')).toBe(0)
  })
})

describe('topicFromMarker', () => {
  it('reads the label, flattens spaces, and cuts a long label', () => {
    expect(topicFromMarker('<|TOPIC 週末の予定|>')).toBe('週末の予定')
    expect(topicFromMarker('<|TOPIC  the   weekend |>')).toBe('the weekend')
    expect(topicFromMarker(`<|TOPIC ${'a'.repeat(60)}|>`)).toHaveLength(TOPIC_LIMITS.maxLabelLength)
  })

  it('ignores another marker and an empty label', () => {
    expect(topicFromMarker('<|ACT {"emotion":"happy"}|>')).toBeUndefined()
    expect(topicFromMarker('<|TOPIC   |>')).toBeUndefined()
  })
})

describe('currentTopicThread', () => {
  it('follows the newest lines while each one is near the next', () => {
    const thread = currentTopicThread([line('週末の予定'), line('ラーメン屋'), line('ラーメン', true)])

    expect(thread).toMatchObject({ topic: 'ラーメン', lines: 2, cold: false })
    expect(thread?.heat).toBeCloseTo(TOPIC_LIMITS.answeredHeatStep * TOPIC_LIMITS.unansweredHeatStep)
  })

  it('cools fast without owner answers, and slowly with them', () => {
    expect(currentTopicThread([line('ラーメン'), line('ラーメン')])?.cold).toBe(true)
    expect(currentTopicThread([line('ラーメン', true), line('ラーメン', true)])?.cold).toBe(false)
  })

  it('uses the text of a line without a label, and gives nothing without lines', () => {
    expect(currentTopicThread([line(undefined, false, '今日は雨だね')])?.topic).toBe('今日は雨だね')
    expect(currentTopicThread([])).toBeUndefined()
  })

  it('takes another similarity, for example one of embeddings', () => {
    const always = () => 1
    expect(currentTopicThread([line('ラーメン'), line('週末')], always)?.lines).toBe(2)
  })
})

describe('calendarTopicSeeds', () => {
  it('names the month, the day of the week, and the start of a month', () => {
    expect(calendarTopicSeeds('2026-11-01').map(seed => seed.text)).toEqual(['It is November.', 'Today is Sunday, a weekend day.', 'A new month just started.'])
  })

  it('names the end of a month, and the end and start of a year', () => {
    expect(calendarTopicSeeds('2026-11-30').map(seed => seed.text)).toContain('The month ends soon.')
    expect(calendarTopicSeeds('2026-12-24').map(seed => seed.text)).toContain('The year ends soon.')
    expect(calendarTopicSeeds('2027-01-02').map(seed => seed.text)).toContain('A new year just started.')
    expect(calendarTopicSeeds('2026-11-11').map(seed => seed.text)).toEqual(['It is November.', 'Today is Wednesday.'])
  })
})

describe('pickTopicSeeds', () => {
  const seeds: TopicSeed[] = [
    { text: 'The owner likes ramen', source: 'memory' },
    { text: 'The owner plays the piano', source: 'memory' },
    { text: 'It is November.', source: 'calendar' },
  ]

  it('draws seeds without repeats, up to the count', () => {
    const picked = pickTopicSeeds({ seeds, recentTopics: [], random: sequence(0) })

    expect(picked.map(seed => seed.text)).toEqual(['The owner likes ramen', 'The owner plays the piano', 'It is November.'])
    expect(pickTopicSeeds({ seeds, recentTopics: [], random: sequence(0), count: 1 })).toHaveLength(1)
  })

  it('never offers a seed near a recent topic, and drops duplicates', () => {
    const picked = pickTopicSeeds({ seeds: [...seeds, seeds[0]], recentTopics: ['the owner likes ramen'], random: sequence(0) })

    expect(picked.map(seed => seed.text)).toEqual(['The owner plays the piano', 'It is November.'])
  })

  it('never offers a resting seed', () => {
    const picked = pickTopicSeeds({ seeds, recentTopics: [], resting: ['It is November.'], random: sequence(0) })

    expect(picked.map(seed => seed.text)).not.toContain('It is November.')
  })

  it('gives a lower weight to a seed that is a little near a recent topic', () => {
    // "The owner plays the piano" shares pairs with "The owner", so the far seed fills most of the weight.
    const picked = pickTopicSeeds({
      seeds: [{ text: 'The owner plays the piano', source: 'memory' }, { text: 'It is November.', source: 'calendar' }],
      recentTopics: ['The owner'],
      random: sequence(0.5),
      count: 1,
    })

    expect(picked.map(seed => seed.text)).toEqual(['It is November.'])
  })
})

describe('variety measures', () => {
  it('counts distinct character pairs', () => {
    expect(distinctN(['ねえねえ'])).toBeCloseTo(2 / 3)
    expect(distinctN(['a'])).toBe(0)
  })

  it('gives 0 entropy for one type and 1 for all types equally', () => {
    expect(speechTypeEntropy(['ask', 'ask'])).toBe(0)
    expect(speechTypeEntropy(['react', 'joke', 'ask', 'recall', 'think-aloud', 'watch-quietly'])).toBeCloseTo(1)
    expect(speechTypeEntropy([])).toBe(0)
  })

  it('measures the similarity of consecutive topics', () => {
    expect(topicVariety([line('ラーメン'), line('ラーメン'), line('週末')], ['ask']).topicSimilarity).toBeCloseTo(0.5)
    expect(topicVariety([line('ラーメン')], []).topicSimilarity).toBeUndefined()
  })
})
