import type { LineLength, LineLengthContext } from './line-length'

import { describe, expect, it } from 'vitest'

import { drawLineLength } from './line-length'

/** The share of each length over evenly spread random values. */
function shares(context: LineLengthContext) {
  const counts: Record<LineLength, number> = { short: 0, normal: 0, long: 0 }
  const steps = 1000
  for (let step = 0; step < steps; step++)
    counts[drawLineLength(context, () => (step + 0.5) / steps)]++
  return { short: counts.short / steps, normal: counts.normal / steps, long: counts.long / steps }
}

describe('drawLineLength', () => {
  it('talks the longest in solo talk', () => {
    const solo = { mode: 'idle' as const, smallTalk: true, solo: true, hasNotes: false }

    expect(drawLineLength(solo, () => 0.05)).toBe('short')
    expect(drawLineLength(solo, () => 0.3)).toBe('normal')
    expect(drawLineLength(solo, () => 0.9)).toBe('long')
  })

  it('keeps idle speech mostly short and never long', () => {
    expect(shares({ mode: 'idle', smallTalk: false, hasNotes: true })).toEqual({ short: 0.7, normal: 0.3, long: 0 })
  })

  it('talks longer in small talk', () => {
    expect(shares({ mode: 'idle', smallTalk: true, hasNotes: false })).toEqual({ short: 0.2, normal: 0.5, long: 0.3 })
  })

  it('keeps to quick reactions on a busy screen, and looks back at length in a calm moment with notes', () => {
    expect(shares({ mode: 'commentary', smallTalk: false, activity: 0.8, hasNotes: true })).toEqual({ short: 0.8, normal: 0.2, long: 0 })
    expect(shares({ mode: 'commentary', smallTalk: false, activity: 0.1, hasNotes: true })).toEqual({ short: 0.4, normal: 0.4, long: 0.2 })
  })

  it('gives a calm moment without notes no long line, because it has nothing to look back on', () => {
    expect(shares({ mode: 'commentary', smallTalk: false, activity: 0.1, hasNotes: false })).toEqual({ short: 0.4, normal: 0.6, long: 0 })
  })
})
