import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import type { MemoryWorkPlan } from '../libs/memory-work'

import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { rawTool } from '@xsai/tool'
import { defineStore } from 'pinia'
import { safeParse } from 'valibot'
import { onScopeDispose, readonly, ref } from 'vue'
import { toJsonSchema } from 'xsschema'

import { useTextGeneration } from '../composables/text-generation'
import { MEMORY_WORK_LIMITS, MemoryReportSchema, memoryWorkRequest, ownerProfileRequest, planMemoryWork } from '../libs/memory-work'
import { Ticker } from '../workers/ticker'
import { useChatStore } from './chat'
import { useChatSessionStore } from './chat/session-store'
import { useDeviceFloorStore } from './device-floor'
import { useMemoryStore } from './memory'
import { useMemoryRecallStore } from './memory-recall'
import { useAiriCardStore } from './modules/airi-card'
import { useOwnerProfileStore } from './owner-profile'

/** The runner looks for a finished conversation this often. */
const TICK_INTERVAL_MS = 60_000
/** One model call of the memory work gives up after this time. */
const CALL_TIMEOUT_MS = 60_000
/** After a failed pass, the next try of the same conversation waits this long, so a broken provider costs little. */
const RETRY_AFTER_MS = 30 * 60_000

/** What the last pass did, for Settings. It holds no memory text. */
export interface LastMemoryWork {
  at: number
  written: number
  profileWritten: boolean
  failed?: boolean
}

/**
 * Writes lasting facts from finished conversations into long-term memory, and the owner profile from the memories.
 *
 * - A conversation counts as finished after 20 quiet minutes. A pass reads the part after the last pass.
 * - The model answers with the `report_memories` tool. It updates a related memory instead of adding a copy.
 * - Only the renderer leader of the device that holds the floor runs it, so two devices never do the same pass.
 *
 * Use when:
 * - An app starts its renderer. Call `initialize` once with the synced Pinia runtime.
 *
 * Expects:
 * - Long-term memory and this setting are on. Both are off by default.
 */
export const useMemoryWorkStore = defineStore('memory-work', () => {
  const enabled = useLocalStorageManualReset<boolean>('memory/work-enabled', false)
  /** The last message that a pass covered, for each conversation. It stays on the device. */
  const coveredThrough = useLocalStorageManualReset<Record<string, string>>('memory/work-through', {})
  const lastWork = ref<LastMemoryWork>()

  const memory = useMemoryStore()
  const memoryRecall = useMemoryRecallStore()
  const ownerProfile = useOwnerProfileStore()
  const deviceFloor = useDeviceFloorStore()
  const chat = useChatStore()
  const chatSession = useChatSessionStore()
  const cardStore = useAiriCardStore()
  const { generateText } = useTextGeneration()

  let leadership: Pick<SyncedPiniaRuntime, 'isLeader' | 'onLeadershipChange'> | undefined
  let stopLeadershipListener: (() => void) | undefined
  let running = false
  const retryAfter = new Map<string, number>()

  /** The chat model of a conversation, or undefined when its card has none. */
  function modelOf(sessionId: string) {
    const characterId = chatSession.sessionMetas[sessionId]?.characterId ?? cardStore.activeCardId
    const { provider, model } = cardStore.getModules(characterId).consciousness
    return provider && model ? { providerId: provider, model } : undefined
  }

  /** Asks the model for the facts of one finished part. Resolves to its report, or undefined without one. */
  async function askForFacts(selection: { providerId: string, model: string }, plan: MemoryWorkPlan, personaId: string) {
    const related = (await memoryRecall.recall(plan.ownerText || plan.transcript.slice(-500), personaId, MEMORY_WORK_LIMITS.relatedCount)).entries
    let report: { entries: { id: string | null, description: string, body: string }[] } | undefined
    const stop = new AbortController()
    const tool = rawTool({
      name: 'report_memories',
      description: 'Report the lasting facts of the conversation to save. Give an empty list when nothing is worth saving.',
      parameters: await toJsonSchema(MemoryReportSchema),
      execute: async (input) => {
        const parsed = safeParse(MemoryReportSchema, input)
        if (!parsed.success)
          return `Give entries as a list of at most ${MEMORY_WORK_LIMITS.maxEntries} objects with id (or null), description, and body.`
        report = parsed.output
        // The report is all that the pass needs, so the call stops before the model writes on.
        queueMicrotask(() => stop.abort('The memory work got its report.'))
        return 'Recorded.'
      },
    })
    try {
      await generateText(selection, 'memory')(memoryWorkRequest(plan, related), AbortSignal.any([stop.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]), [tool])
    }
    catch (error) {
      if (!report)
        throw error
    }
    return report
  }

  /** Writes the owner profile again from the memories of a card and the general ones. */
  async function writeProfile(selection: { providerId: string, model: string }, personaId: string) {
    const entries = memory.entries.filter(entry => !entry.persona || entry.persona === personaId)
    if (!entries.length)
      return false
    const text = await generateText(selection, 'memory')(ownerProfileRequest(entries), AbortSignal.timeout(CALL_TIMEOUT_MS))
    if (!text.trim())
      return false
    await ownerProfile.set(text)
    return true
  }

  async function runPass(sessionId: string, plan: MemoryWorkPlan, now: number) {
    const selection = modelOf(sessionId)
    if (!selection)
      return
    const personaId = chat.personaOf(sessionId)
    try {
      const report = await askForFacts(selection, plan, personaId)
      let written = 0
      for (const entry of report?.entries ?? []) {
        if (await memory.write({ id: entry.id ?? undefined, description: entry.description, body: entry.body }, personaId))
          written += 1
      }
      coveredThrough.value = { ...coveredThrough.value, [sessionId]: plan.throughMessageId }
      const profileWritten = written > 0 && ownerProfile.enabled ? await writeProfile(selection, personaId) : false
      lastWork.value = { at: now, written, profileWritten }
    }
    catch (error) {
      retryAfter.set(sessionId, now + RETRY_AFTER_MS)
      lastWork.value = { at: now, written: 0, profileWritten: false, failed: true }
      console.warn('[memory-work] A pass failed:', errorMessageFrom(error))
    }
  }

  async function tick() {
    const now = Date.now()
    if (running || !leadership?.isLeader() || !enabled.value || !memory.enabled || !deviceFloor.holdsFloor)
      return
    const sessionId = chatSession.activeSessionId
    const meta = sessionId ? chatSession.sessionMetas[sessionId] : undefined
    // Only the owner's own conversations hold facts about the owner. A task space or a scene does not.
    if (!sessionId || !meta || meta.recipeId || meta.bindings?.length || (retryAfter.get(sessionId) ?? 0) > now)
      return
    await memory.ready()
    const plan = planMemoryWork(chatSession.getSessionMessages(sessionId), coveredThrough.value[sessionId], now)
    if (!plan)
      return
    running = true
    try {
      await runPass(sessionId, plan, now)
    }
    finally {
      running = false
    }
  }

  /** Writes the owner profile now from the memories of the open conversation's card. Settings uses it. */
  async function writeProfileNow() {
    const sessionId = chatSession.activeSessionId
    const selection = sessionId ? modelOf(sessionId) : undefined
    if (!sessionId || !selection)
      return false
    await memory.ready()
    return writeProfile(selection, chat.personaOf(sessionId))
  }

  const ticker = new Ticker(TICK_INTERVAL_MS, () => void tick())

  /** Starts the ticks while this renderer leads. Later calls do nothing. */
  function initialize(syncedPinia: Pick<SyncedPiniaRuntime, 'isLeader' | 'onLeadershipChange'>) {
    if (leadership)
      return
    leadership = syncedPinia
    stopLeadershipListener = syncedPinia.onLeadershipChange((isLeader) => {
      if (isLeader)
        ticker.start()
      else
        ticker.stop()
    })
  }

  function dispose() {
    stopLeadershipListener?.()
    stopLeadershipListener = undefined
    ticker.stop()
    leadership = undefined
  }

  onScopeDispose(dispose)

  function resetState() {
    enabled.reset()
    coveredThrough.reset()
  }

  return {
    enabled,
    lastWork: readonly(lastWork),
    initialize,
    dispose,
    tick,
    writeProfileNow,
    resetState,
  }
})
