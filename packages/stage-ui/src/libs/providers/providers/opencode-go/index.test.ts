import type { GenerationProvider } from '@proj-airi/provider-inference'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { providerOpenCodeGo } from '.'

const config = { apiKey: 'test-key' }
const context = { t: (key: string) => key }

async function generationOf(model: string, options?: Parameters<GenerationProvider['generation']>[1]) {
  const provider = await providerOpenCodeGo.createProvider(config) as GenerationProvider
  const request = provider.generation(model, options)
  if (request.protocol !== 'chat-completions')
    throw new Error('OpenCode Go uses the chat completions protocol.')
  return request.config
}

describe('providerOpenCodeGo', () => {
  beforeEach(() => {
    // The desktop app reaches the relay through its custom scheme. The web app needs a page origin, which Node lacks.
    vi.stubEnv('RUNTIME_ENVIRONMENT', 'electron')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('sends each request to the relay with the key of the owner', async () => {
    const request = await generationOf('gpt-6-luna')

    expect(String(request.baseURL)).toBe('airi-relay://opencode-go/')
    expect(request.apiKey).toBe('test-key')
    expect(request.model).toBe('gpt-6-luna')
  })

  it('turns reasoning off with the field that each model reads', async () => {
    const off = { reasoning: 'disabled' } as const

    expect(await generationOf('gpt-6-luna', off)).toMatchObject({ reasoningEffort: 'none' })
    expect(await generationOf('deepseek-v4.1-flash', off)).toMatchObject({ thinking: { type: 'disabled' } })
    expect(await generationOf('minimax-m3.1-flash', off)).toMatchObject({ reasoningEffort: 'minimal' })
  })

  it('asks for the effort of the owner when reasoning is on', async () => {
    expect(await generationOf('gpt-6-luna', { reasoning: 'enabled', effort: 'high' })).toMatchObject({ reasoningEffort: 'high' })
    expect(await generationOf('gpt-6-luna', { reasoning: 'enabled' })).toMatchObject({ reasoningEffort: 'medium' })
    expect(await generationOf('mimo-v2.6-pro', { reasoning: 'enabled', effort: 'high' })).toMatchObject({ thinking: { type: 'enabled' } })
  })

  // A wrong reasoning field gives HTTP 400, so a model with an unknown field gets none.
  it('sends no reasoning field for a model that is not in its list', async () => {
    const request = await generationOf('kimi-k3', { reasoning: 'disabled' })

    expect(request).not.toHaveProperty('reasoningEffort')
    expect(request).not.toHaveProperty('thinking')
  })

  it('sends no reasoning field when the caller gives no reasoning choice', async () => {
    const request = await generationOf('gpt-6-luna')

    expect(request).not.toHaveProperty('reasoningEffort')
  })

  it('reads from the model list which models read images', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      object: 'list',
      data: [
        { id: 'gpt-6-luna', name: 'GPT-6 Luna', description: 'A small model.', modalities: { input: ['text', 'image/jpeg', 'image/png'] }, limit: { context: 1_050_000 } },
        { id: 'glm-5.3', modalities: { input: ['text'] } },
        { id: 'unknown-input' },
      ],
    }))
    const provider = await providerOpenCodeGo.createProvider(config)

    const models = await providerOpenCodeGo.extraMethods!.listModels!(config, provider, context)

    expect(fetchMock).toHaveBeenCalledWith('airi-relay://opencode-go/models', { headers: { Authorization: 'Bearer test-key' } })
    expect(models).toEqual([
      { id: 'gpt-6-luna', name: 'GPT-6 Luna', provider: 'opencode-go', description: 'A small model.', contextLength: 1_050_000, inputModalities: ['text', 'image'], metadata: { abilities: { vision: true } } },
      { id: 'glm-5.3', name: 'glm-5.3', provider: 'opencode-go', description: undefined, contextLength: undefined, inputModalities: ['text'], metadata: { abilities: { vision: false } } },
      { id: 'unknown-input', name: 'unknown-input', provider: 'opencode-go', description: undefined, contextLength: undefined, inputModalities: undefined, metadata: undefined },
    ])
  })

  it('reports a failed model list with its status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 401 }))
    const provider = await providerOpenCodeGo.createProvider(config)

    await expect(providerOpenCodeGo.extraMethods!.listModels!(config, provider, context)).rejects.toThrow('HTTP 401')
  })

  it('gives the relay URL to the shared validators, which read the base URL from the config', async () => {
    const validators = await Promise.all(providerOpenCodeGo.validators!.validateConfig!.map(create => create(context)))

    const results = await Promise.all(validators.map(validator => validator.validator(config, context)))

    expect(results.map(result => result.valid)).toEqual([true])
  })

  it('is not offered in the mobile app, which has no relay', async () => {
    vi.stubEnv('RUNTIME_ENVIRONMENT', 'capacitor')

    expect(await providerOpenCodeGo.isAvailableBy!()).toBe(false)
  })
})
