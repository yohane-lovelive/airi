import type { SpeechType, SpeechTypeContext } from './speech-types'

import { describe, expect, it } from 'vitest'

import { createSeededRandom } from './simulation'
import { drawSpeechType, SPEECH_TYPES } from './speech-types'

const NEUTRAL: SpeechTypeContext = { energy: 1, mood: 0, boredom: 0.5, curiosity: 0.3, eventShare: 0.5, recentTypes: [] }

/** The share of each type in many draws with a fixed seed. */
function shares(context: SpeechTypeContext, draws = 4_000) {
  const random = createSeededRandom(7)
  const counts = Object.fromEntries(SPEECH_TYPES.map(type => [type, 0])) as Record<SpeechType, number>
  for (let index = 0; index < draws; index++)
    counts[drawSpeechType(context, random)]++
  return Object.fromEntries(SPEECH_TYPES.map(type => [type, counts[type] / draws])) as Record<SpeechType, number>
}

describe('speech type draw', () => {
  it('can draw every type from a neutral state', () => {
    const result = shares(NEUTRAL)

    for (const type of SPEECH_TYPES)
      expect(result[type]).toBeGreaterThan(0.02)
  })

  it('favors a reaction when an event started the turn', () => {
    const result = shares({ ...NEUTRAL, eventShare: 1 })

    expect(Math.max(...SPEECH_TYPES.map(type => result[type]))).toBe(result.react)
  })

  it('favors a memory or a question when boredom started the turn', () => {
    const bored = shares({ ...NEUTRAL, eventShare: 0, boredom: 1 })
    const excited = shares({ ...NEUTRAL, eventShare: 1, boredom: 1 })

    expect(bored.recall).toBeGreaterThan(excited.recall * 2)
    expect(bored.ask).toBeGreaterThan(excited.ask)
  })

  it('favors quiet speech at low energy and jokes in a good mood', () => {
    expect(shares({ ...NEUTRAL, energy: 0 })['watch-quietly']).toBeGreaterThan(shares(NEUTRAL)['watch-quietly'] * 2)
    expect(shares({ ...NEUTRAL, mood: 1 }).joke).toBeGreaterThan(shares({ ...NEUTRAL, mood: -1 }).joke * 2)
  })

  // Code owns variety: a type that the character just used rarely comes again at once.
  it('lowers the weight of the newest type more than older repeats', () => {
    const fresh = shares({ ...NEUTRAL, eventShare: 1 })
    const newest = shares({ ...NEUTRAL, eventShare: 1, recentTypes: ['joke', 'react'] })
    const older = shares({ ...NEUTRAL, eventShare: 1, recentTypes: ['react', 'joke'] })

    expect(newest.react).toBeLessThan(fresh.react / 2)
    expect(older.react).toBeGreaterThan(newest.react)
  })

  it('gives the same draws for the same seed', () => {
    const first = createSeededRandom(11)
    const second = createSeededRandom(11)
    const draws = (random: () => number) => Array.from({ length: 20 }, () => drawSpeechType(NEUTRAL, random))

    expect(draws(first)).toEqual(draws(second))
  })
})
