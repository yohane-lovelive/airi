import type { ReminderRequest } from '@proj-airi/core-agent'

import type { MissionRecord } from '../database/repos/missions.repo'

import { errorMessageFrom } from '@moeru/std'
import { createReminder, settleMissionRun, stopMission } from '@proj-airi/core-agent'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { useBroadcastChannel } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { missionsRepo } from '../database/repos/missions.repo'

export type { MissionInstance, ReminderRequest } from '@proj-airi/core-agent'

/**
 * Missions that the model created from the owner's words, for example reminders.
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
  const active = computed(() => missions.value.filter(mission => mission.status === 'scheduled'))

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

  /** Stops a mission. Resolves to whether an active mission stopped. */
  async function stop(id: string) {
    let stopped = false
    await missionsRepo.change(id, (stored) => {
      if (stored.status !== 'scheduled')
        return undefined
      stopped = true
      return stopMission(stored, Date.now())
    })
    if (stopped)
      await publish([id])
    return stopped
  }

  /**
   * Records one run of a mission. The change reads the stored mission, so a mission that the owner stopped during the run
   * stays stopped.
   */
  async function settle(id: string, outcome: 'delivered' | 'expired', now: number) {
    await missionsRepo.change(id, stored => stored.status === 'scheduled' ? settleMissionRun(stored, outcome, now) : undefined)
    await publish([id])
  }

  /** Removes ended missions from the list. */
  async function removeEnded() {
    const ids = missions.value.filter(mission => mission.status !== 'scheduled').map(mission => mission.id)
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
    stop,
    settle,
    removeEnded,
    resetState,
  }
})
