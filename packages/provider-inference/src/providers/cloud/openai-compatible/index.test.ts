import type { GenerationProvider } from '../../../types'

import { describe, expect, it } from 'vitest'

import { providerOpenAICompatible } from './index'

async function createProvider(reasoningControl: 'none' | 'thinking' | 'reasoning-effort', api: 'chat-completions' | 'responses' = 'chat-completions') {
  return await providerOpenAICompatible.createProvider({
    apiKey: 'sk-test',
    baseUrl: 'https://example.test/v1/',
    api,
    reasoningControl,
  }) as GenerationProvider
}

describe('providerOpenAICompatible reasoning control', () => {
  it('sends no reasoning field by default, so an unknown server keeps working', async () => {
    const provider = await createProvider('none')

    const config = provider.generation('model', { reasoning: 'disabled' }).config

    expect(config).not.toHaveProperty('thinking')
    expect(config).not.toHaveProperty('reasoningEffort')
  })

  it('switches thinking on and off for a DeepSeek-style server, at any effort', async () => {
    const provider = await createProvider('thinking')

    expect(provider.generation('model', { reasoning: 'disabled' }).config).toMatchObject({ thinking: { type: 'disabled' } })
    expect(provider.generation('model', { reasoning: 'enabled', effort: 'low' }).config).toMatchObject({ thinking: { type: 'enabled' } })
    expect(provider.generation('model').config).not.toHaveProperty('thinking')
  })

  it('sends the effort for an OpenAI-style server, and none for disabled', async () => {
    const provider = await createProvider('reasoning-effort')

    expect(provider.generation('model', { reasoning: 'enabled', effort: 'low' }).config).toMatchObject({ reasoningEffort: 'low' })
    expect(provider.generation('model', { reasoning: 'enabled' }).config).toMatchObject({ reasoningEffort: 'medium' })
    expect(provider.generation('model', { reasoning: 'disabled' }).config).toMatchObject({ reasoningEffort: 'none' })
  })

  it('uses the effort form of the Responses API', async () => {
    const provider = await createProvider('thinking', 'responses')

    expect(provider.generation('model', { reasoning: 'enabled', effort: 'high' }).config).toMatchObject({ reasoning: { effort: 'high' } })
  })
})
