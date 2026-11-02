import { describe, expect, it } from 'vitest'

import { truncateAndNormalize, withPrefix } from './prefix'

describe('withPrefix', () => {
  it('puts the prefix of each task before the text', () => {
    expect(withPrefix('好きな食べ物は？', 'query')).toBe('task: search result | query: 好きな食べ物は？')
    expect(withPrefix('好物はラーメン', 'document')).toBe('title: none | text: 好物はラーメン')
    expect(withPrefix('ラーメン', 'similarity')).toBe('task: sentence similarity | query: ラーメン')
  })
})

describe('truncateAndNormalize', () => {
  it('keeps the first values and scales the vector to length 1', () => {
    const vector = truncateAndNormalize([3, 4, 12], 2)

    expect(vector).toEqual([0.6, 0.8])
  })

  it('cuts to 256 dimensions by default', () => {
    const vector = truncateAndNormalize(Array.from<number>({ length: 768 }).fill(1))

    expect(vector).toHaveLength(256)
    expect(Math.hypot(...vector)).toBeCloseTo(1)
  })

  it('leaves a zero vector as it is', () => {
    expect(truncateAndNormalize([0, 0, 0], 2)).toEqual([0, 0])
  })
})
