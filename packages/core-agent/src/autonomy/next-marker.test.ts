import { describe, expect, it } from 'vitest'

import { nextFromMarker } from './next-marker'

describe('nextFromMarker', () => {
  it('reads the three values in any case, and nothing else', () => {
    expect(nextFromMarker('<|NEXT continue|>')).toBe('continue')
    expect(nextFromMarker(' <|NEXT Wait|> ')).toBe('wait')
    expect(nextFromMarker('<|NEXT done |>')).toBe('done')
    expect(nextFromMarker('<|NEXT later|>')).toBeUndefined()
    expect(nextFromMarker('<|TOPIC done|>')).toBeUndefined()
  })
})
