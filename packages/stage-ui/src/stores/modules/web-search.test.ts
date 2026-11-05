import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import { WEB_SEARCH_TOOLSET_PROMPT } from '../../tools/web-search'
import { useLlmToolsetPromptsStore } from '../ai/chat-llm/toolset-prompts'
import { useWebSearchStore } from './web-search'

describe('useWebSearchStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('configured gate', () => {
    it('is false when disabled even with a key present', () => {
      const store = useWebSearchStore()
      store.enabled = false
      store.apiKey = 'tvly-key'
      expect(store.configured).toBe(false)
    })

    it('is false when enabled with an empty or whitespace-only key', () => {
      const store = useWebSearchStore()
      store.enabled = true

      store.apiKey = ''
      expect(store.configured).toBe(false)

      store.apiKey = '   \n\t'
      expect(store.configured).toBe(false)
    })

    it('is true when enabled with a non-empty key', () => {
      const store = useWebSearchStore()
      store.enabled = true
      store.apiKey = 'tvly-key'
      expect(store.configured).toBe(true)
    })
  })

  describe('the mcp service', () => {
    it('needs no key, only the runtime of the desktop app and a tool name', () => {
      const store = useWebSearchStore()
      store.enabled = true
      store.provider = 'mcp'
      expect(store.configured).toBe(false)
      expect(store.mcpSearchServer).toBeUndefined()

      store.setMcpCallTool(async () => ({}))
      expect(store.configured).toBe(true)
      expect(store.mcpSearchServer).toBe('ddg-search')

      store.mcpToolName = ' '
      expect(store.configured).toBe(false)
    })

    it('names no server for another service, so the MCP proxy tools reach them all', () => {
      const store = useWebSearchStore()
      store.enabled = true
      store.provider = 'tavily'
      store.apiKey = 'key'
      store.setMcpCallTool(async () => ({}))

      expect(store.mcpSearchServer).toBeUndefined()
    })
  })

  describe('searches of lines that the character starts', () => {
    it('counts them per local day, and stops at the limit of the owner', () => {
      const store = useWebSearchStore()
      store.autonomousPerDay = 2
      const day = new Date(2026, 10, 5, 12).getTime()

      expect(store.autonomousSearchesLeft(day)).toBe(2)
      expect(store.takeAutonomousSearch(day)).toBe(true)
      expect(store.takeAutonomousSearch(day)).toBe(true)
      expect(store.takeAutonomousSearch(day)).toBe(false)
      expect(store.autonomousSearchesUsed(day)).toBe(2)

      const nextDay = new Date(2026, 10, 6, 0, 1).getTime()
      expect(store.autonomousSearchesLeft(nextDay)).toBe(2)
    })

    it('allows none at a limit of zero', () => {
      const store = useWebSearchStore()
      store.autonomousPerDay = 0

      expect(store.takeAutonomousSearch()).toBe(false)
    })
  })

  describe('toolset-prompt watcher', () => {
    it('uses only the selected service key and updates prompt availability on switching', async () => {
      const store = useWebSearchStore()
      const prompts = useLlmToolsetPromptsStore()
      store.enabled = true
      store.apiKey = 'tavily-key'
      store.provider = 'deepseek'
      await nextTick()
      expect(store.configured).toBe(false)
      expect(prompts.activeToolsetPrompt).not.toContain(WEB_SEARCH_TOOLSET_PROMPT)

      store.activeApiKey = 'deepseek-key'
      await nextTick()
      expect(store.deepSeekApiKey).toBe('deepseek-key')
      expect(store.apiKey).toBe('tavily-key')
      expect(store.configured).toBe(true)
      expect(prompts.activeToolsetPrompt).toContain(WEB_SEARCH_TOOLSET_PROMPT)

      store.provider = 'tavily'
      expect(store.activeApiKey).toBe('tavily-key')
      store.activeApiKey = ''
      await nextTick()
      expect(store.configured).toBe(false)
      expect(store.deepSeekApiKey).toBe('deepseek-key')
      expect(prompts.activeToolsetPrompt).not.toContain(WEB_SEARCH_TOOLSET_PROMPT)
    })

    it('clears both keys and disables search on reset', async () => {
      const store = useWebSearchStore()
      store.enabled = true
      store.apiKey = 'tavily-key'
      store.provider = 'deepseek'
      store.deepSeekApiKey = 'deepseek-key'
      await nextTick()
      store.resetState()
      await nextTick()
      expect(store.enabled).toBe(false)
      expect(store.provider).toBe('tavily')
      expect(store.apiKey).toBe('')
      expect(store.deepSeekApiKey).toBe('')
      expect(store.configured).toBe(false)
      expect(useLlmToolsetPromptsStore().activeToolsetPrompt).not.toContain(WEB_SEARCH_TOOLSET_PROMPT)
    })

    it('registers the safety prompt when configured and clears it when not', async () => {
      const store = useWebSearchStore()
      const prompts = useLlmToolsetPromptsStore()

      // { immediate: true } runs the watcher on creation while unconfigured, so
      // the safety prompt must be absent until a key is set.
      expect(prompts.promptsByProvider['web-search']).toBeUndefined()
      expect(prompts.activeToolsetPrompt).not.toContain(WEB_SEARCH_TOOLSET_PROMPT)

      store.enabled = true
      store.apiKey = 'tvly-key'
      await nextTick()

      expect(prompts.promptsByProvider['web-search']).toBeDefined()
      expect(prompts.activeToolsetPrompt).toContain(WEB_SEARCH_TOOLSET_PROMPT)

      // Disabling the module must remove the paired prompt so the model is never
      // told about a tool it can no longer call.
      store.enabled = false
      await nextTick()

      expect(prompts.promptsByProvider['web-search']).toBeUndefined()
      expect(prompts.activeToolsetPrompt).not.toContain(WEB_SEARCH_TOOLSET_PROMPT)
    })
  })
})
