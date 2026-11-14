import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { useDecisionModelStore } from './decision-model'

const { stored } = vi.hoisted(() => ({
  stored: { providers: {} as Record<string, { definitionId: string, status: string, config: Record<string, unknown> }> },
}))

// The provider config store syncs with the account, so the test gives only its list of providers.
vi.mock('./providers/config', () => ({
  useProviderConfigStore: () => stored,
}))

const question = {
  react: { type: 'noul', instructions: 'Did something happen?', criteria: { true: 'Yes.', false: 'No.' } },
} as const

describe('decision model store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stored.providers = reactive({})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is not configured until the owner sets up the Google provider', () => {
    stored.providers.openai = { definitionId: 'openai', status: 'configured', config: { apiKey: 'other-key' } }
    const store = useDecisionModelStore()

    expect(store.configured).toBe(false)

    stored.providers['google-generative-ai'] = { definitionId: 'google-generative-ai', status: 'configured', config: { apiKey: 'google-key' } }

    expect(store.configured).toBe(true)
  })

  it('does not use a Google provider that failed its validation', () => {
    stored.providers['google-generative-ai'] = { definitionId: 'google-generative-ai', status: 'invalid', config: { apiKey: 'google-key' } }

    expect(useDecisionModelStore().configured).toBe(false)
  })

  it('asks Gemini Decision 1 with the key of the Google provider', async () => {
    stored.providers['google-generative-ai'] = { definitionId: 'google-generative-ai', status: 'configured', config: { apiKey: ' google-key ' } }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ answers: { react: { type: 'noul', noul: 0.9 } } }))

    const result = await useDecisionModelStore().decide([{ type: 'text', text: 'x' }], question)

    expect(result.answers.react.probability).toBe(0.9)
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('x-goog-api-key')).toBe('google-key')
  })

  it('rejects without a request while no key is set', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await expect(useDecisionModelStore().decide([{ type: 'text', text: 'x' }], question)).rejects.toThrow('no Gemini API key')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
