import { bigramSimilarity } from '@proj-airi/core-agent'
import { describe, expect, it, vi } from 'vitest'

import { TopicVectors } from './topic-vectors'

/** A unit vector whose cosine with `unit(0)` is `cos`. */
function unit(cos: number) {
  return [cos, Math.sqrt(1 - cos ** 2)]
}

describe('topicVectors', () => {
  it('embeds each text once, and compares two texts with vectors on the scale of character pairs', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(text => text === 'ラーメン' ? unit(1) : unit(0.8)))
    const vectors = new TopicVectors({ embed })

    await vectors.prepare(['ラーメン', '麺類', 'ラーメン'])
    await vectors.prepare(['ラーメン', '麺類'])

    expect(embed).toHaveBeenCalledTimes(1)
    expect(embed.mock.calls[0][0]).toEqual(['ラーメン', '麺類'])
    // A cosine of 0.8 is the middle of the range from 0.7 to 0.9.
    expect(vectors.similarity('ラーメン', '麺類')).toBeCloseTo(0.5)
    expect(vectors.lastMode).toBe('vectors')
  })

  it('compares by character pairs when the server fails, and asks again in a later turn', async () => {
    const embed = vi.fn<(texts: string[]) => Promise<number[][]>>()
      .mockRejectedValueOnce(new Error('503'))
      .mockImplementation(async texts => texts.map(() => unit(1)))
    const vectors = new TopicVectors({ embed })

    await vectors.prepare(['ラーメン屋', 'ラーメン'])
    expect(vectors.similarity('ラーメン屋', 'ラーメン')).toBe(bigramSimilarity('ラーメン屋', 'ラーメン'))
    expect(vectors.lastMode).toBe('characters')

    await vectors.prepare(['ラーメン屋', 'ラーメン'])
    expect(vectors.similarity('ラーメン屋', 'ラーメン')).toBe(1)
    expect(vectors.lastMode).toBe('vectors')
  })

  it('keeps the recently used texts and drops the oldest ones over the capacity', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => unit(1)))
    const vectors = new TopicVectors({ embed, capacity: 2 })

    await vectors.prepare(['a', 'b'])
    await vectors.prepare(['a'])
    await vectors.prepare(['c'])
    await vectors.prepare(['a', 'b'])

    // `b` was the oldest when `c` came, so only `b` is embedded again.
    expect(embed.mock.calls.map(call => call[0])).toEqual([['a', 'b'], ['c'], ['b']])
  })
})
