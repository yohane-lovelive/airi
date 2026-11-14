import { describe, expect, it, vi } from 'vitest'

import { modelForScreen } from './screen-model'

const card = { provider: 'card-provider', model: 'card-model' }
const screen = { provider: 'screen-provider', model: 'screen-model' }

describe('modelForScreen', () => {
  it('uses the choice of the owner', () => {
    expect(modelForScreen(card, screen, () => true)).toEqual(screen)
  })

  it('uses the model of the card without a complete choice', () => {
    expect(modelForScreen(card, { provider: '', model: '' }, () => true)).toEqual(card)
    expect(modelForScreen(card, { provider: 'screen-provider', model: '' }, () => true)).toEqual(card)
  })

  it('uses the model of the card, with a warning, when the provider is not configured', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(modelForScreen(card, screen, () => false)).toEqual(card)
    expect(warn).toHaveBeenCalledOnce()

    warn.mockRestore()
  })
})
