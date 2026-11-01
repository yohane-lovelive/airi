import type { MissionInstance } from '@proj-airi/core-agent'
import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import { errorMessageFrom } from '@moeru/std'
import { collectDueMissions, deliverReminder, missedRemindersNoticeText, reminderNoticeText, smallTalkPastLimit } from '@proj-airi/core-agent'
import { groupBy } from 'es-toolkit'
import { defineStore, storeToRefs } from 'pinia'
import { onScopeDispose } from 'vue'
import { useI18n } from 'vue-i18n'

import { Ticker } from '../workers/ticker'
import { useChatStore } from './chat'
import { useChatSessionStore } from './chat/session-store'
import { useMissionsStore } from './missions'
import { useSpeechStore } from './modules/speech'

/** The leader checks the clock once each second, so a reminder is at most about one second late. */
const TICK_INTERVAL_MS = 1_000

/**
 * Runs the missions on the renderer leader: it finds due reminders and makes sure that the owner gets each one. It ends
 * small talk at its time limit. Small talk itself speaks through the initiative runner.
 *
 * State model:
 * - The missions store keeps the persisted instances. This store keeps only runtime state: the ticker and the ids of
 *   runs that deliver now.
 * - The ticker runs only while this renderer is the leader, and a tick does nothing while missions are off. A leader
 *   change stops it in the old leader and starts it in the new one. A run in flight in the old leader finishes, and its settle reads the stored
 *   mission, so the new leader does not repeat a settled run.
 *
 * Use when:
 * - An app starts its renderer. Call `initialize` once with the synced Pinia runtime.
 */
export const useMissionRunnerStore = defineStore('mission-runner', () => {
  const missions = useMissionsStore()
  const chat = useChatStore()
  const chatSession = useChatSessionStore()
  const speech = useSpeechStore()
  const { activeSessionId } = storeToRefs(chatSession)
  const { t } = useI18n()

  /** Ids of runs that deliver now. A tick skips them, so a slow model call never starts a second delivery. */
  const delivering = new Set<string>()
  const ticker = new Ticker(TICK_INTERVAL_MS, () => void tick())
  let leadership: SyncedPiniaRuntime | undefined
  let stopLeadershipListener: (() => void) | undefined

  /**
   * The conversation that gets a notice. A mission keeps the conversation where the owner asked for it. If the owner
   * deleted that conversation, the notice goes to the current one, so the reminder still reaches the owner.
   */
  function targetSession(mission: MissionInstance) {
    return chatSession.sessionMetas[mission.sessionId] ? mission.sessionId : activeSessionId.value
  }

  /** Whether the owner hears speech. Without it, the reminder also shows as an operating system notification. */
  function speechOutputOn() {
    return speech.enabled && speech.activeSpeechProvider !== 'speech-noop'
  }

  /** Shows an operating system notification. The web app shows it only when the owner granted the permission. */
  function notifySystem(body: string) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted')
      return
    try {
      // eslint-disable-next-line no-new
      new Notification(t('stage.missions.notification-title'), { body })
    }
    catch (error) {
      console.warn('[missions] Failed to show a notification:', errorMessageFrom(error))
    }
  }

  /**
   * Makes sure that the owner gets a reminder. `deliverReminder` tries the model, then the fixed text. If nothing played,
   * or speech output is off, an operating system notification also shows the fixed text.
   */
  async function deliver(sessionId: string, text: string, fixedText: string) {
    const result = await deliverReminder(notice => chat.notifyConversation(sessionId, { ...notice, mustSpeak: true }), text, fixedText)
    if (result === 'unspoken' || !speechOutputOn())
      notifySystem(fixedText)
  }

  async function run(ids: string[], work: () => Promise<void>) {
    for (const id of ids)
      delivering.add(id)
    try {
      await work()
    }
    catch (error) {
      console.warn('[missions] Failed to run a mission:', errorMessageFrom(error))
    }
    finally {
      for (const id of ids)
        delivering.delete(id)
    }
  }

  async function tick() {
    if (!leadership?.isLeader() || !missions.enabled)
      return
    await missions.ready()
    const now = Date.now()
    const waiting = missions.missions.filter(mission => !delivering.has(mission.id))
    const { due, missed, expired } = collectDueMissions(waiting, now, { missedAgeLimitMs: missions.missedAgeLimitHours * 60 * 60_000 })

    for (const mission of expired)
      void run([mission.id], () => missions.settle(mission.id, 'expired', now))

    for (const mission of smallTalkPastLimit(waiting, now)) {
      void run([mission.id], async () => {
        await missions.stop(mission.id, 'time')
      })
    }

    for (const mission of due) {
      void run([mission.id], async () => {
        await deliver(targetSession(mission), reminderNoticeText(mission), t('stage.missions.fixed-reminder', { text: mission.values.text }))
        await missions.settle(mission.id, 'delivered', Date.now())
      })
    }

    // All late reminders of one conversation share one notice, so the character does not speak many times after a start.
    for (const [sessionId, group] of Object.entries(groupBy(missed, targetSession))) {
      void run(group.map(mission => mission.id), async () => {
        const fixedText = group.map(mission => t('stage.missions.fixed-reminder', { text: mission.values.text })).join('\n')
        await deliver(sessionId, missedRemindersNoticeText(group), fixedText)
        for (const mission of group)
          await missions.settle(mission.id, 'delivered', Date.now())
      })
    }
  }

  /** Starts the ticker while this renderer leads. Later calls do nothing. */
  function initialize(syncedPinia: SyncedPiniaRuntime) {
    if (leadership)
      return
    leadership = syncedPinia
    missions.supported = true
    stopLeadershipListener = syncedPinia.onLeadershipChange((isLeader) => {
      if (isLeader)
        ticker.start()
      else
        ticker.stop()
    })
    if (syncedPinia.isLeader())
      ticker.start()
  }

  function dispose() {
    stopLeadershipListener?.()
    stopLeadershipListener = undefined
    ticker.stop()
    leadership = undefined
  }

  onScopeDispose(dispose)

  return {
    initialize,
    dispose,
  }
})
