import { describe, expect, it } from 'vitest'

import { promptPartSizes } from './prompt-parts'

describe('prompt part sizes', () => {
  it('measures the system prompt, the summary, and the history apart', () => {
    const sizes = promptPartSizes({
      turns: [
        { type: 'system', id: 'system-identity', authority: 'system', content: [{ type: 'text', text: 'persona' }] },
        { type: 'system', id: 'history-summary', authority: 'context', content: [{ type: 'summary', text: 'earlier' }] },
        { type: 'user', id: 'u1', content: [{ type: 'text', text: 'hello' }] },
      ],
    })

    expect(sizes).toMatchObject({ systemChars: 7, summaryChars: 7, historyTurns: 1 })
    expect(sizes.historyChars).toBeGreaterThan(5)
  })
})
