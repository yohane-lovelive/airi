import { describe, expect, it } from 'vitest'

import { formatTimePrefix, withoutTimePrefix } from './datetime-prefix'

/**
 * @example
 * formatTimePrefix(new Date(2026, 3, 25, 18, 47).getTime())
 */
describe('formatTimePrefix', () => {
  /**
   * @example
   * Timestamp prefixes use `[YYYY-MM-DD HH:MM] ` with a trailing space.
   */
  it('wraps `[YYYY-MM-DD HH:MM]` with trailing space', () => {
    const ts = new Date(2026, 3, 25, 18, 47, 0).getTime()
    expect(formatTimePrefix(ts)).toBe('[2026-04-25 18:47] ')
  })

  /**
   * @example
   * Single-digit date parts are zero-padded.
   */
  it('zero-pads month, day, hour, and minute', () => {
    const ts = new Date(2026, 0, 5, 3, 7, 0).getTime()
    expect(formatTimePrefix(ts)).toBe('[2026-01-05 03:07] ')
  })

  /**
   * @example
   * Same-minute timestamps share the same prompt prefix.
   */
  it('shares the same prefix across timestamps in the same minute', () => {
    const a = new Date(2026, 3, 25, 18, 47, 12).getTime()
    const b = new Date(2026, 3, 25, 18, 47, 58).getTime()
    expect(formatTimePrefix(a)).toBe(formatTimePrefix(b))
  })
})

describe('withoutTimePrefix', () => {
  it('removes the time prefix at the start, and keeps other brackets', () => {
    expect(withoutTimePrefix(`${formatTimePrefix(new Date(2026, 10, 3, 14, 49).getTime())}好きな食べ物は？`)).toBe('好きな食べ物は？')
    expect(withoutTimePrefix('[メモ] [2026-11-03 14:49] そのまま')).toBe('[メモ] [2026-11-03 14:49] そのまま')
  })
})
