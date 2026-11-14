import { createGeminiDecisionClient } from '@proj-airi/core-agent'
import { defineStore } from 'pinia'
import { computed } from 'vue'

import { useProviderConfigStore } from './providers/config'

/** Gemini Decision 1 takes the key of the Gemini chat models, so the owner sets one key for both. */
const KEY_PROVIDER_DEFINITION = 'google-generative-ai'

/**
 * The decision model of this device: Gemini Decision 1 with the key of the Google provider of the owner.
 *
 * Use when:
 * - Autonomous speech needs a judgement before a call of the chat model, for example whether the screen shows a
 *   moment to speak.
 *
 * Returns:
 * - `configured`, which is false until the owner sets up the Google provider. A caller then makes no judgement.
 * - `decide`, which rejects without a key and when the request fails. The page calls the Gemini API directly.
 */
export const useDecisionModelStore = defineStore('decision-model', () => {
  const providerConfig = useProviderConfigStore()

  const apiKey = computed(() => {
    const provider = Object.values(providerConfig.providers).find(candidate => candidate.definitionId === KEY_PROVIDER_DEFINITION && candidate.status === 'configured')
    const key = provider?.config.apiKey
    return typeof key === 'string' && key.trim() ? key.trim() : undefined
  })
  const configured = computed(() => apiKey.value !== undefined)

  const client = createGeminiDecisionClient({ apiKey: () => apiKey.value })

  return {
    configured,
    decide: client.decide,
  }
})
