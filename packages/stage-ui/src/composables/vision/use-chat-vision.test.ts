// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useConsciousnessSettingsStore } from '../../stores/modules/consciousness-settings'
import { useChatVision } from './use-chat-vision'

const { catalog } = vi.hoisted(() => ({ catalog: { vision: undefined as boolean | undefined } }))

// The provider catalog, the module stores, and the session are the boundary. The fakes say what the catalog lists.
vi.mock('../../stores/providers/provider', () => ({
  useProviderStore: () => ({
    getModelsForProvider: () => [{ id: 'deepseek-v4.1-flash', metadata: catalog.vision === undefined ? {} : { abilities: { vision: catalog.vision } } }],
  }),
}))
vi.mock('../../stores/modules/consciousness', () => ({
  useConsciousnessStore: () => ({ activeProvider: 'openai-compatible', activeModel: 'deepseek-v4.1-flash' }),
}))
vi.mock('../../stores/modules/vision', () => ({
  useVisionStore: () => ({ enabled: true, activeProvider: 'vision-provider', activeModel: 'vision-model', useForChat: true, useForToolImages: true }),
}))
vi.mock('../../stores/chat/session-store', () => ({
  useChatSessionStore: () => ({ characterMembersOf: () => [] }),
}))
vi.mock('../../stores/modules/airi-card', () => ({
  useAiriCardStore: () => ({ getCard: () => undefined }),
}))
vi.mock('./use-vision-inference', () => ({
  useVisionInference: () => ({ runVisionInference: vi.fn() }),
}))

describe('useChatVision', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    catalog.vision = undefined
  })

  // ROOT CAUSE:
  // The catalog of an OpenAI-compatible server lists no image input, so every frame of an autonomous turn went
  // through the vision module first, which took 12 to 31 seconds. The owner can now say that the model reads images.
  it('sends images to a model that the owner marked as reading them, without the vision module', async () => {
    const vision = useChatVision()
    // A call without a session uses the selection of the module stores.
    const selection = vision.selectionOf(undefined)
    expect(selection.chat).toEqual({ provider: 'openai-compatible', model: 'deepseek-v4.1-flash' })
    expect(vision.readsAttachedImages(selection)).toBe(true)

    await useConsciousnessSettingsStore().setImageInput('openai-compatible', 'deepseek-v4.1-flash', 'reads')

    expect(vision.readsAttachedImages(selection)).toBe(false)
    expect(vision.toolImageReader(selection)).toBeUndefined()
  })

  it('uses the vision module for a model that the owner marked as reading no images, whatever the catalog says', async () => {
    catalog.vision = true
    const vision = useChatVision()
    const selection = vision.selectionOf(undefined)
    expect(vision.readsAttachedImages(selection)).toBe(false)

    await useConsciousnessSettingsStore().setImageInput('openai-compatible', 'deepseek-v4.1-flash', 'no-images')

    expect(vision.readsAttachedImages(selection)).toBe(true)
  })
})
