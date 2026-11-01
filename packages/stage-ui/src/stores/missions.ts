import type { CommentaryRequest, MissionEndReason, ReminderRequest, SmallTalkRequest } from '@proj-airi/core-agent'

import type { MissionRecord } from '../database/repos/missions.repo'

import { errorMessageFrom } from '@moeru/std'
import { activeCommentary, activeForegroundMission, activeSmallTalk, createCommentary, createReminder, createSmallTalk, isMissionActive, settleMissionRun, stopMission } from '@proj-airi/core-agent'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { useBroadcastChannel } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { missionsRepo } from '../database/repos/missions.repo'

export type { CommentaryRequest, MissionInstance, ReminderRequest, SmallTalkRequest } from '@proj-airi/core-agent'

/**
 * Missions that the model created from the owner's words, for example reminders, small talk, and commentary.
 * IndexedDB keeps the instances. After each change, the other windows read them again.
 *
 * Use when:
 * - The mission tools create, list, or stop a mission, or Settings list the missions.
 * - The mission runner on the leader reads the due missions and records each run.
 *
 * Expects:
 * - Only the renderer leader runs missions. Any window can create or stop one.
 *
 * Returns:
 * - All missions, the active ones, the owner settings, `ready` for the first read, and actions that change missions.
 */
export const useMissionsStore = defineStore('missions', () => {
  const records = ref<MissionRecord[]>([])
  /** Whether the character can create missions, and whether the leader runs them. Off by default. */
  const enabled = useLocalStorageManualReset<boolean>('missions/enabled', false)
  /** A reminder that the app missed for longer than this gets no notice. Its state changes only. */
  const missedAgeLimitHours = useLocalStorageManualReset<number>('missions/missed-age-limit-hours', 24)
  /**
   * Whether this app runs missions. The mission runner sets it when an app initializes it. An app without a runner,
   * for example the mobile app, offers no mission tools, so the model never creates a reminder that never runs.
   */
  const supported = ref(false)
  const { data: changed, post } = useBroadcastChannel<string[], string[]>({ name: 'airi:missions' })
  let pendingLoad: Promise<void> = Promise.resolve()

  const missions = computed(() => records.value.map(record => record.mission))
  const active = computed(() => missions.value.filter(isMissionActive))

  /** Reads the missions again, after the reads that started before. */
  function load() {
    pendingLoad = pendingLoad.catch(() => {}).then(async () => {
      records.value = await missionsRepo.list()
    })
    return pendingLoad
  }

  /** Resolves after every read that started before the call. Until the first read, `missions` is empty. */
  function ready() {
    return pendingLoad.catch(() => {})
  }

  async function publish(ids: string[]) {
    await load()
    post(ids)
  }

  /** Creates a reminder in an owner conversation. On a refusal, `reason` tells the model what to change. */
  async function addReminder(request: ReminderRequest, sessionId: string) {
    const result = createReminder({ id: nanoid(), sessionId, request, now: Date.now() })
    if (!result.ok)
      return result
    await missionsRepo.add(result.mission)
    await publish([result.mission.id])
    return result
  }

  /**
   * Starts small talk in an owner conversation. On a refusal, `reason` tells the model what to change.
   * It reads the stored missions first, so small talk that another window started counts.
   */
  async function addSmallTalk(request: SmallTalkRequest, sessionId: string) {
    const stored = (await missionsRepo.list()).map(record => record.mission)
    const result = createSmallTalk({ id: nanoid(), sessionId, request, now: Date.now(), missions: stored })
    if (!result.ok)
      return result
    await missionsRepo.add(result.mission)
    await publish([result.mission.id])
    return result
  }

  /**
   * Starts commentary on one window in an owner conversation. An empty app takes `appInFront`. On a refusal, `reason`
   * tells the model what to change.
   */
  async function addCommentary(request: CommentaryRequest, sessionId: string, appInFront?: string) {
    const stored = (await missionsRepo.list()).map(record => record.mission)
    const result = createCommentary({ id: nanoid(), sessionId, request, ...(appInFront ? { appInFront } : {}), now: Date.now(), missions: stored })
    if (!result.ok)
      return result
    await missionsRepo.add(result.mission)
    await publish([result.mission.id])
    return result
  }

  /** Ends a mission. Resolves to whether an active mission ended. `owner` is the owner's or the model's stop. */
  async function stop(id: string, reason: MissionEndReason = 'owner') {
    let stopped = false
    await missionsRepo.change(id, (stored) => {
      if (!isMissionActive(stored))
        return undefined
      stopped = true
      return stopMission(stored, Date.now(), reason)
    })
    if (stopped)
      await publish([id])
    return stopped
  }

  /** The small talk that runs now, if any. */
  function smallTalkAt(now: number) {
    return activeSmallTalk(missions.value, now)
  }

  /** The commentary that runs now, if any. */
  function commentaryAt(now: number) {
    return activeCommentary(missions.value, now)
  }

  /**
   * Ends the foreground mission that runs now, for example on a request for quiet. With `only`, it ends that template
   * only, for example small talk when the owner leaves. Resolves to whether one ended.
   */
  async function endForeground(reason: MissionEndReason, only?: 'small-talk' | 'commentary') {
    const running = activeForegroundMission(missions.value, Date.now())
    return running && (!only || running.template === only) ? stop(running.id, reason) : false
  }

  /**
   * Records one run of a mission. The change reads the stored mission, so a mission that the owner stopped during the run
   * stays stopped.
   */
  async function settle(id: string, outcome: 'delivered' | 'expired', now: number) {
    await missionsRepo.change(id, stored => stored.template === 'reminder' && stored.status === 'scheduled' ? settleMissionRun(stored, outcome, now) : undefined)
    await publish([id])
  }

  /** Removes ended missions from the list. */
  async function removeEnded() {
    const ids = missions.value.filter(mission => !isMissionActive(mission)).map(mission => mission.id)
    if (!ids.length)
      return
    await missionsRepo.remove(ids, Date.now())
    await publish(ids)
  }

  async function resetState() {
    enabled.reset()
    missedAgeLimitHours.reset()
    await missionsRepo.clear()
    await load()
    post([])
  }

  function reload() {
    void load().catch(error => console.warn('[missions] Failed to read the missions:', errorMessageFrom(error)))
  }
  watch(changed, reload)
  reload()

  return {
    missions,
    active,
    supported,
    enabled,
    missedAgeLimitHours,
    ready,
    addReminder,
    addSmallTalk,
    stop,
    addCommentary,
    smallTalkAt,
    commentaryAt,
    endForeground,
    settle,
    removeEnded,
    resetState,
  }
})
