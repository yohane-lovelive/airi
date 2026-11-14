import { describe, expect, it } from 'vitest'

import { screenGateInput } from './screen-gate'

describe('screenGateInput', () => {
  it('gives the earlier frame before the current one, both at low resolution, after a line that tells their order', () => {
    const [intro, first, second] = screenGateInput('EARLIER', 'CURRENT')

    expect(intro.type).toBe('text')
    expect(first).toEqual({ type: 'image', data: 'EARLIER', mimeType: 'image/jpeg', resolution: 'low' })
    expect(second).toEqual({ type: 'image', data: 'CURRENT', mimeType: 'image/jpeg', resolution: 'low' })
  })
})
