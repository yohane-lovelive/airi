// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { chatRequestOptionsOf, useConsciousnessSettingsStore } from './consciousness-settings'

describe('consciousness settings store', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('turns model reasoning off by default, and autonomous speech follows the replies', () => {
    const store = useConsciousnessSettingsStore()

    expect(store.reasoningLevel).toBe('off')
    expect(store.autonomousReasoningLevel).toBe('same')
    expect(store.levelFor('autonomous')).toBe('off')
  })

  it('reads the old switch as the level that sends the same request', () => {
    localStorage.setItem('settings/consciousness/reasoning', 'true')

    expect(useConsciousnessSettingsStore().reasoningLevel).toBe('medium')
  })

  it('persists changes through store actions, and gives autonomous speech its own level', async () => {
    const store = useConsciousnessSettingsStore()
    await store.setReasoningLevel('high')
    await store.setAutonomousReasoningLevel('off')

    expect(store.levelFor('reply')).toBe('high')
    expect(store.levelFor('autonomous')).toBe('off')
    expect(localStorage.getItem('settings/consciousness/reasoning-level')).toBe('high')
    expect(localStorage.getItem('settings/consciousness/autonomous-reasoning-level')).toBe('off')

    await store.resetState()

    expect(store.reasoningLevel).toBe('off')
    expect(store.autonomousReasoningLevel).toBe('same')
  })

  it('ignores storage events because Pinia owns cross-window synchronization', () => {
    const store = useConsciousnessSettingsStore()

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'settings/consciousness/reasoning-level',
      newValue: 'high',
    }))

    expect(store.reasoningLevel).toBe('off')
  })

  it('turns a level into the request options of a provider', () => {
    expect(chatRequestOptionsOf('default')).toBeUndefined()
    expect(chatRequestOptionsOf('off')).toEqual({ reasoning: 'disabled' })
    expect(chatRequestOptionsOf('low')).toEqual({ reasoning: 'enabled', effort: 'low' })
  })

  it('follows the model list until the owner says whether a model reads images', async () => {
    const store = useConsciousnessSettingsStore()

    expect(store.readsImages('openai-compatible', 'deepseek-v4.1-flash', undefined)).toBe(false)
    expect(store.readsImages('openai', 'gpt-5.1', true)).toBe(true)

    await store.setImageInput('openai-compatible', 'deepseek-v4.1-flash', 'reads')
    await store.setImageInput('openai', 'gpt-5.1', 'no-images')
    expect(store.readsImages('openai-compatible', 'deepseek-v4.1-flash', undefined)).toBe(true)
    expect(store.readsImages('openai', 'gpt-5.1', true)).toBe(false)
    expect(JSON.parse(localStorage.getItem('settings/consciousness/image-input')!)).toEqual({ 'openai-compatible/deepseek-v4.1-flash': 'reads', 'openai/gpt-5.1': 'no-images' })

    await store.setImageInput('openai', 'gpt-5.1', 'catalog')
    expect(store.imageInputChoiceOf('openai', 'gpt-5.1')).toBe('catalog')
    expect(store.readsImages('openai', 'gpt-5.1', true)).toBe(true)
  })

  it('reads the stored choices, and ignores a broken value', () => {
    localStorage.setItem('settings/consciousness/image-input', JSON.stringify({ 'a/b': 'reads', 'c/d': 'maybe' }))
    expect(useConsciousnessSettingsStore().imageInputChoiceOf('a', 'b')).toBe('catalog')

    setActivePinia(createPinia())
    localStorage.setItem('settings/consciousness/image-input', JSON.stringify({ 'a/b': 'reads' }))
    expect(useConsciousnessSettingsStore().imageInputChoiceOf('a', 'b')).toBe('reads')
  })
})
