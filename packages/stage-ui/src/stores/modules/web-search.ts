import type { McpToolRuntime } from '../../tools/mcp'
import type { WebSearchProvider } from '../../tools/web-search'

import { initiativeTimeFrom } from '@proj-airi/core-agent'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { clamp } from 'es-toolkit'
import { defineStore } from 'pinia'
import { computed, shallowRef, watch } from 'vue'

import { createWebSearchTools, WEB_SEARCH_TOOLSET_PROMPT } from '../../tools/web-search'
import { useLlmToolsetPromptsStore } from '../ai/chat-llm/toolset-prompts'

/** The searches that turns the character starts on its own can make in a day. The owner's replies have no limit. */
export const WEB_SEARCH_LIMITS = {
  minAutonomousPerDay: 0,
  maxAutonomousPerDay: 200,
  defaultAutonomousPerDay: 20,
} as const

/** The tool of the `ddg-search` server that the README shows for `mcp.json`. */
const DEFAULT_MCP_SEARCH_TOOL = 'ddg-search::search'

/**
 * Device-local search credentials and tool-prompt lifecycle for the selected service.
 *
 * Renderer-only: unlike the messaging modules it does not broadcast to a backend
 * service, so there is no configurator channel here. The tool itself is mounted
 * by `resolveWebSearchTools` in `stores/ai/chat-llm/tool-resolver.ts`, gated on
 * {@link configured}; this store owns the paired system-prompt guidance so the
 * "web content is data, not instructions" rule is present exactly when the tool
 * is, and gone when it is not.
 */
export const useWebSearchStore = defineStore('web-search', () => {
  const toolsetPromptsStore = useLlmToolsetPromptsStore()

  const enabled = useLocalStorageManualReset<boolean>('settings/web-search/enabled', false)
  const apiKey = useLocalStorageManualReset<string>('settings/web-search/api-key', '')
  const provider = useLocalStorageManualReset<WebSearchProvider>('settings/web-search/provider', 'tavily')
  const deepSeekApiKey = useLocalStorageManualReset<string>('settings/web-search/deepseek-api-key', '')
  const autonomousPerDay = useLocalStorageManualReset<number>('settings/web-search/autonomous-per-day', WEB_SEARCH_LIMITS.defaultAutonomousPerDay)
  /** The searches of the local day. The device keeps them, so a restart does not start the count again. */
  const autonomousUsage = useLocalStorageManualReset<{ day: string, count: number }>('settings/web-search/autonomous-usage', { day: '', count: 0 })

  /** The MCP tool that answers searches. `mcp.json` belongs to this device, so the name does too. */
  const mcpToolName = useLocalStorageManualReset<string>('settings/web-search/mcp-tool-name', DEFAULT_MCP_SEARCH_TOOL)
  // Only the desktop app gives this. The web app has no MCP runtime, so it offers no `mcp` service.
  const mcpCallTool = shallowRef<McpToolRuntime['callTool']>()
  const mcpAvailable = computed(() => mcpCallTool.value !== undefined)
  function setMcpCallTool(callTool: McpToolRuntime['callTool']) {
    mcpCallTool.value = callTool
  }

  const activeApiKey = computed({
    get: () => provider.value === 'deepseek' ? deepSeekApiKey.value : apiKey.value,
    set: (value: string) => {
      if (provider.value === 'deepseek')
        deepSeekApiKey.value = value
      else
        apiKey.value = value
    },
  })
  const configured = computed(() => enabled.value && (provider.value === 'mcp'
    ? mcpAvailable.value && mcpToolName.value.trim().length > 0
    : activeApiKey.value.trim().length > 0))
  /** The server that answers searches. The MCP proxy tools must not reach it, or a call would skip the limits. */
  const mcpSearchServer = computed(() => configured.value && provider.value === 'mcp' ? mcpToolName.value.trim().split('::')[0] : undefined)

  /** Builds the search tool of the selected service. Mount it only while {@link configured} is true. */
  async function createTools(refuse?: () => string | undefined) {
    const callTool = mcpCallTool.value
    return createWebSearchTools({
      provider: provider.value,
      apiKey: activeApiKey.value.trim(),
      ...(provider.value === 'mcp' && callTool ? { mcp: { toolName: mcpToolName.value.trim(), callTool } } : {}),
      ...(refuse ? { refuse } : {}),
    })
  }

  // Keep the safety/when-to-search guidance mounted iff the tool is mounted.
  // Clauses must key off the same `configured` gate the tool does, never a raw
  // key read, so the model is never told about a tool it cannot call.
  watch(configured, (isConfigured) => {
    if (isConfigured)
      toolsetPromptsStore.registerToolsetPrompts('web-search', [{ id: 'web-search', content: WEB_SEARCH_TOOLSET_PROMPT }])
    else
      toolsetPromptsStore.clearToolsetPrompts('web-search')
  }, { immediate: true })

  function autonomousSearchesUsed(now = Date.now()) {
    return autonomousUsage.value.day === initiativeTimeFrom(new Date(now)).localDay ? autonomousUsage.value.count : 0
  }

  function autonomousSearchesLeft(now = Date.now()) {
    const limit = clamp(autonomousPerDay.value, WEB_SEARCH_LIMITS.minAutonomousPerDay, WEB_SEARCH_LIMITS.maxAutonomousPerDay)
    return Math.max(0, limit - autonomousSearchesUsed(now))
  }

  /** Counts one search of a turn that the character started. Returns false when none is left today. */
  function takeAutonomousSearch(now = Date.now()) {
    if (autonomousSearchesLeft(now) <= 0)
      return false
    autonomousUsage.value = { day: initiativeTimeFrom(new Date(now)).localDay, count: autonomousSearchesUsed(now) + 1 }
    return true
  }

  function resetState() {
    mcpToolName.reset()
    autonomousPerDay.reset()
    autonomousUsage.reset()
    enabled.reset()
    apiKey.reset()
    provider.reset()
    deepSeekApiKey.reset()
  }

  return {
    enabled,
    apiKey,
    provider,
    deepSeekApiKey,
    activeApiKey,
    configured,
    mcpToolName,
    mcpAvailable,
    mcpSearchServer,
    setMcpCallTool,
    createTools,
    autonomousPerDay,
    autonomousSearchesUsed,
    autonomousSearchesLeft,
    takeAutonomousSearch,
    resetState,
  }
})
