import { describe, expect, it } from 'vitest'

import { addUsageCall, countRequestImages, firstKeptUsageDay, usageByPurpose, usageDayOf } from './usage'

const at = new Date(2026, 10, 1, 9, 30).getTime()

describe('usage records', () => {
  it('adds calls to the record of a day, and keeps unreported calls out of the sums', () => {
    const first = addUsageCall(undefined, { purpose: 'owner-reply', model: 'm', at, calls: 2, tokens: { input: 100, output: 20, total: 120 }, images: 1 })
    const second = addUsageCall(first, { purpose: 'owner-reply', model: 'm', at, calls: 1, images: 0 })

    expect(second).toEqual({ day: '2026-11-01', purpose: 'owner-reply', model: 'm', calls: 3, unreportedCalls: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120, images: 1 })
  })

  it('sums each purpose from a day on, in the fixed purpose order', () => {
    const record = (day: string, purpose: 'owner-reply' | 'initiative', model: string, totalTokens: number) => ({ day, purpose, model, calls: 1, unreportedCalls: 0, inputTokens: totalTokens, outputTokens: 0, totalTokens, images: 0 })
    const records = [
      record('2026-10-31', 'owner-reply', 'm', 1_000),
      record('2026-11-01', 'initiative', 'm', 50),
      record('2026-11-01', 'owner-reply', 'm', 200),
      record('2026-11-01', 'owner-reply', 'n', 300),
    ]

    expect(usageByPurpose(records, '2026-11-01').map(({ purpose, calls, totalTokens }) => ({ purpose, calls, totalTokens }))).toEqual([
      { purpose: 'owner-reply', calls: 2, totalTokens: 500 },
      { purpose: 'initiative', calls: 1, totalTokens: 50 },
    ])
  })

  it('keeps 30 days, today included', () => {
    expect(usageDayOf(at)).toBe('2026-11-01')
    expect(firstKeptUsageDay(at)).toBe('2026-10-03')
  })

  it('counts the images of owner turns and tool results', () => {
    expect(countRequestImages({
      turns: [
        { type: 'user', id: 'u', content: [{ type: 'image', url: 'a' }, { type: 'text', text: 'look' }] },
        {
          type: 'assistant',
          id: 'a',
          status: 'completed',
          rounds: [{
            id: 'r',
            content: [],
            projectionIssues: [],
            toolInvocations: [{ id: 't', callId: 'c', name: 'screenshot', arguments: '{}', execution: { status: 'succeeded', output: [{ type: 'image', url: 'b' }] } }],
          }],
        },
      ],
    })).toBe(2)
  })
})
