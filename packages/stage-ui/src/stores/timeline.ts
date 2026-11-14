import type { Timeline, TimelineNote } from '@proj-airi/core-agent'

import { errorMessageFrom } from '@moeru/std'
import { addTimelineNotes, applyTimelineSummary, EMPTY_TIMELINE, setTimelineScene, timelineNotesToSummarize, timelineSummaryRequest } from '@proj-airi/core-agent'
import { useBroadcastChannel } from '@vueuse/core'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

import { useTextGeneration } from '../composables/text-generation'
import { timelineRepo } from '../database/repos/timeline.repo'
import { useChatSessionStore } from './chat/session-store'
import { useAiriCardStore } from './modules/airi-card'

/** A summary request that takes longer than this is given up. The next change tries again. */
const SUMMARY_TIMEOUT_MS = 120_000

/**
 * The screen timeline of each conversation: short notes of what happened on the screen, a summary of older notes, and
 * the current scene. It is the only history of the screen, because frames never stay.
 *
 * - Code writes notes, for example an app switch. The character writes notes and the scene with markers.
 * - IndexedDB keeps each timeline on the device. It never syncs. Other windows read it again after each change.
 * - Past its limits, the chat model of the session summarizes the oldest notes in the background.
 *
 * Use when:
 * - A decision turn with the screen reads the timeline of its conversation. Call `load` first, then `timelineOf`.
 * - Code or a marker adds a note or the scene.
 */
export const useTimelineStore = defineStore('timeline', () => {
  const chatSession = useChatSessionStore()
  const cardStore = useAiriCardStore()
  const { generateText } = useTextGeneration()
  const timelines = ref<Record<string, Timeline>>({})
  /** Sessions with a summary request in flight. */
  const summarizing = new Set<string>()
  const { data: changed, post } = useBroadcastChannel<string, string>({ name: 'airi:timeline' })

  /** The timeline that this window read last. Empty before `load`. */
  function timelineOf(sessionId: string): Timeline {
    return timelines.value[sessionId] ?? EMPTY_TIMELINE
  }

  /** Reads the timeline of a session from the device. */
  async function load(sessionId: string) {
    const stored = await timelineRepo.get(sessionId)
    if (stored)
      timelines.value = { ...timelines.value, [sessionId]: stored }
    else
      delete timelines.value[sessionId]
    return timelineOf(sessionId)
  }

  async function change(sessionId: string, next: (stored: Timeline) => Timeline) {
    const timeline = await timelineRepo.change(sessionId, stored => next(stored ?? EMPTY_TIMELINE))
    timelines.value = { ...timelines.value, [sessionId]: timeline }
    post(sessionId)
    void summarize(sessionId)
    return timeline
  }

  function addNotes(sessionId: string, notes: readonly TimelineNote[]) {
    return change(sessionId, stored => addTimelineNotes(stored, notes))
  }

  function setScene(sessionId: string, text: string, at: number) {
    return change(sessionId, stored => setTimelineScene(stored, text, at))
  }

  /** Summarizes the oldest notes when the timeline grew past its limits. A failure only logs, and the next change tries again. */
  async function summarize(sessionId: string) {
    const now = Date.now()
    const notes = timelineNotesToSummarize(timelineOf(sessionId), now)
    const meta = chatSession.sessionMetas[sessionId]
    if (!notes || !meta || summarizing.has(sessionId))
      return
    const { provider, model } = cardStore.getModules(meta.characterId).consciousness
    if (!provider || !model)
      return
    summarizing.add(sessionId)
    try {
      const text = (await generateText({ providerId: provider, model }, 'timeline')(timelineSummaryRequest(timelineOf(sessionId), notes), AbortSignal.timeout(SUMMARY_TIMEOUT_MS))).trim()
      const until = notes.at(-1)!.at
      if (text)
        await change(sessionId, stored => applyTimelineSummary(stored, text, until))
    }
    catch (error) {
      console.warn('[timeline] Failed to summarize the screen timeline:', errorMessageFrom(error))
    }
    finally {
      summarizing.delete(sessionId)
    }
  }

  /** Deletes the timeline of one session, for example when the owner deletes the conversation. */
  async function clear(sessionId: string) {
    await timelineRepo.remove(sessionId)
    delete timelines.value[sessionId]
    post(sessionId)
  }

  async function resetState() {
    await timelineRepo.clear()
    timelines.value = {}
    post('')
  }

  watch(changed, (sessionId) => {
    if (sessionId)
      void load(sessionId).catch(error => console.warn('[timeline] Failed to read a timeline:', errorMessageFrom(error)))
    else
      timelines.value = {}
  })

  return {
    timelines,
    timelineOf,
    load,
    addNotes,
    setScene,
    clear,
    resetState,
  }
})
