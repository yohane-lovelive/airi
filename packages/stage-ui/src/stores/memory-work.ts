import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import type { MemoryPair } from '../libs/memory-merge'
import type { MemoryWorkPlan } from '../libs/memory-work'
import type { MemoryEntry } from '../types/memory'

import { errorMessageFrom } from '@moeru/std'
import { bigramSimilarity, scaledCosine } from '@proj-airi/core-agent'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { rawTool } from '@xsai/tool'
import { defineStore } from 'pinia'
import { safeParse } from 'valibot'
import { onScopeDispose, readonly, ref } from 'vue'
import { toJsonSchema } from 'xsschema'

import { useTextGeneration } from '../composables/text-generation'
import { chooseMergePairs, MEMORY_MERGE_LIMITS, MemoryMergeReportSchema, memoryMergeRequest, memoryMergeText, mergeActionOf } from '../libs/memory-merge'
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
/** The vectors of a merge give up after this time. The merge then compares by shared characters. */
const EMBED_TIMEOUT_MS = 10_000

/** What the last pass did, for Settings. It holds no memory text. */
export interface LastMemoryWork {
  at: number
  written: number
  /** The entries that a merge folded into another entry. */
  merged: number
  profileWritten: boolean
  failed?: boolean
}

/** One merge, for Settings: the descriptions of the entries before, and of the entry after. */
export interface RecentMemoryMerge {
  at: number
  before: string[]
  after: string
}

/**
 * Writes lasting facts from finished conversations into long-term memory, and the owner profile from the memories.
 *
 * - A conversation counts as finished after 20 quiet minutes. A pass reads the part after the last pass.
 * - The model answers with the `report_memories` tool. It updates a related memory instead of adding a copy.
 * - After the pass, a merge compares the entries that changed with their near entries, and the model merges the
 *   entries that say the same thing. Only the card's own entries take part, because general entries belong to the owner.
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
  /** Entries that changed after this time are not checked for copies yet. It stays on the device. */
  const mergeCheckedAt = useLocalStorageManualReset<number>('memory/merge-checked-at', 0)
  /** Pairs of entries that the model judged as different facts, so a merge does not ask about them again. */
  const distinctPairs = useLocalStorageManualReset<string[]>('memory/merge-distinct', [])
  /** The recent merges, newest first, so the owner can see what a merge changed. */
  const recentMerges = useLocalStorageManualReset<RecentMemoryMerge[]>('memory/recent-merges', [])
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

  /**
   * The similarity of each checked entry with its near entries: by the vectors of the server while the memory sync runs,
   * and by shared characters otherwise.
   */
  async function similarPairs(neighbors: Map<MemoryEntry, MemoryEntry[]>): Promise<MemoryPair[]> {
    const unique = new Map<string, MemoryEntry>()
    for (const [checked, near] of neighbors) {
      for (const entry of [checked, ...near])
        unique.set(entry.id, entry)
    }
    let similarity = (left: MemoryEntry, right: MemoryEntry) => bigramSimilarity(memoryMergeText(left), memoryMergeText(right))
    try {
      const ids = [...unique.keys()]
      const vectors = await memoryRecall.embedTexts(ids.map(id => memoryMergeText(unique.get(id)!)), AbortSignal.timeout(EMBED_TIMEOUT_MS))
      const vectorOf = new Map(ids.map((id, index) => [id, vectors[index]]))
      similarity = (left, right) => scaledCosine(vectorOf.get(left.id)!, vectorOf.get(right.id)!)
    }
    catch {
      // Without the server, the merge compares by shared characters, as the recall does.
    }
    return [...neighbors].flatMap(([checked, near]) => near.map(entry => ({ left: checked.id, right: entry.id, similarity: similarity(checked, entry) })))
  }

  /**
   * Merges the entries of a card that say the same thing. It checks the entries that changed since the last merge,
   * oldest first. The next merge starts after the checked entries, except an entry whose pair waits for a later merge.
   *
   * Returns:
   * - The count of entries that it folded into another entry.
   */
  async function mergeCopies(selection: { providerId: string, model: string }, personaId: string) {
    const own = memory.entries.filter(entry => entry.persona === personaId)
    const checked = own
      .filter(entry => entry.updatedAt > mergeCheckedAt.value)
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(0, MEMORY_MERGE_LIMITS.maxChecked)
    if (!checked.length)
      return 0
    const neighbors = new Map<MemoryEntry, MemoryEntry[]>()
    for (const entry of checked) {
      const recalled = await memoryRecall.recall(memoryMergeText(entry), personaId, MEMORY_MERGE_LIMITS.neighbors + 1)
      // NOTICE:
      // Shared words, for example "オーナーは", pushed a copy out of the recall by characters.
      // So without the server, the merge scans the card's entries by its own similarity.
      // Source: a live check on 2026-11-04, and `searchMemories` of `libs/memory-index.ts`.
      // Removal condition: a recall by characters that ranks by `bigramSimilarity`.
      const near = recalled.mode === 'meaning'
        ? recalled.entries
        : [...own].sort((left, right) => bigramSimilarity(memoryMergeText(entry), memoryMergeText(right)) - bigramSimilarity(memoryMergeText(entry), memoryMergeText(left))).slice(0, MEMORY_MERGE_LIMITS.neighbors + 1)
      neighbors.set(entry, near.filter(candidate => candidate.id !== entry.id && candidate.persona === personaId))
    }
    const byId = new Map(own.map(entry => [entry.id, entry]))
    const { send, waiting } = chooseMergePairs(await similarPairs(neighbors), new Set(distinctPairs.value))
    const pairs = send.map(pair => pair.flatMap(id => byId.get(id) ?? [])).filter(pair => pair.length === 2)
    // An entry of a pair that waits stays unchecked, so the next merge finds the pair again.
    const firstWaiting = checked.find(entry => waiting.has(entry.id))
    const checkedThrough = firstWaiting ? firstWaiting.updatedAt - 1 : checked.at(-1)!.updatedAt
    if (!pairs.length) {
      mergeCheckedAt.value = checkedThrough
      return 0
    }

    let report: { pairs: { ids: string[], merged: { description: string, body: string } | null }[] } | undefined
    const stop = new AbortController()
    const tool = rawTool({
      name: 'merge_memories',
      description: 'Report, for each pair, the merged memory, or null to keep the two memories apart.',
      parameters: await toJsonSchema(MemoryMergeReportSchema),
      execute: async (input) => {
        const parsed = safeParse(MemoryMergeReportSchema, input)
        if (!parsed.success)
          return 'Give pairs as a list of objects with the two ids and merged (an object with description and body, or null).'
        report = parsed.output
        // The report is all that the merge needs, so the call stops before the model writes on.
        queueMicrotask(() => stop.abort('The merge got its report.'))
        return 'Recorded.'
      },
    })
    try {
      await generateText(selection, 'memory')(memoryMergeRequest(pairs), AbortSignal.any([stop.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]), [tool])
    }
    catch (error) {
      if (!report)
        throw error
    }

    let merged = 0
    for (const answer of report?.pairs ?? []) {
      const action = mergeActionOf(answer, pairs)
      if (action?.kind === 'distinct') {
        distinctPairs.value = [action.pair, ...distinctPairs.value].slice(0, MEMORY_MERGE_LIMITS.maxDistinctPairs)
        continue
      }
      if (!action)
        continue
      const before = [action.keep, action.forget].map(id => byId.get(id)?.description ?? '')
      await memory.write({ id: action.keep, description: action.description, body: action.body }, personaId)
      if (await memory.forget(action.forget, personaId))
        merged += 1
      recentMerges.value = [{ at: Date.now(), before, after: action.description }, ...recentMerges.value].slice(0, MEMORY_MERGE_LIMITS.maxRecent)
    }
    // A merged entry changed now, so the next merge compares it again. Entries that changed during the call stay too.
    mergeCheckedAt.value = Math.max(mergeCheckedAt.value, checkedThrough)
    return merged
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
      // A failed merge keeps the facts of the pass. The next pass checks the same entries again.
      const merged = await mergeCopies(selection, personaId).catch((error) => {
        console.warn('[memory-work] A merge failed:', errorMessageFrom(error))
        return 0
      })
      const profileWritten = (written > 0 || merged > 0) && ownerProfile.enabled ? await writeProfile(selection, personaId) : false
      lastWork.value = { at: now, written, merged, profileWritten }
    }
    catch (error) {
      retryAfter.set(sessionId, now + RETRY_AFTER_MS)
      lastWork.value = { at: now, written: 0, merged: 0, profileWritten: false, failed: true }
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

  /** Merges the copies of the open conversation's card now. It resolves to the count of merged entries. */
  async function mergeNow() {
    const sessionId = chatSession.activeSessionId
    const selection = sessionId ? modelOf(sessionId) : undefined
    if (!sessionId || !selection)
      return 0
    await memory.ready()
    return mergeCopies(selection, chat.personaOf(sessionId))
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
    mergeCheckedAt.reset()
    distinctPairs.reset()
    recentMerges.reset()
  }

  return {
    enabled,
    lastWork: readonly(lastWork),
    recentMerges,
    initialize,
    dispose,
    tick,
    mergeNow,
    writeProfileNow,
    resetState,
  }
})
