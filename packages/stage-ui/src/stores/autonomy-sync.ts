import type { ReminderMission } from '@proj-airi/core-agent'

import { defineStore, storeToRefs } from 'pinia'

import { useLeaderDocumentSync } from '../composables/use-leader-document-sync'
import { intentionToFields, reminderToFields, splitAutonomyChanges } from '../libs/autonomy-sync'
import { useAuthStore } from './auth'
import { useIntentionsStore } from './intentions'
import { useMemorySyncStore } from './memory-sync'
import { useMissionsStore } from './missions'

function isReminder(mission: { template: string }): mission is ReminderMission {
  return mission.template === 'reminder'
}

/**
 * Synchronizes the reminders and intentions of this device with the account on the server, so the device that holds
 * the floor runs them. Small talk, commentary, and watches stay on their device, because they belong to its screen.
 *
 * Use when:
 * - An app starts its renderer. Call `initialize` once with the synced Pinia runtime.
 *
 * Expects:
 * - The memory sync is active. The floor and this sync turn on together, or two devices would remind the owner twice.
 */
export const useAutonomySyncStore = defineStore('autonomy-sync', () => {
  const { userId } = storeToRefs(useAuthStore())
  const memorySync = useMemorySyncStore()
  const missions = useMissionsStore()
  const intentions = useIntentionsStore()

  const sync = useLeaderDocumentSync({
    name: 'autonomy-records',
    path: '/api/v1/autonomy-records',
    active: () => memorySync.active,
    userId,
    changeSignal: () => missions.changeCount + intentions.changeCount,
    prepare: async () => {
      await Promise.all([missions.ready(), intentions.ready()])
    },
    readLocal: () => Object.fromEntries([
      ...missions.missions.filter(isReminder).map(reminder => [reminder.id, reminderToFields(reminder)] as const),
      ...intentions.intentions.map(intention => [intention.id, intentionToFields(intention)] as const),
    ]),
    async applyLocal(changes) {
      const split = splitAutonomyChanges(changes, {
        reminderIds: new Set(missions.missions.filter(isReminder).map(reminder => reminder.id)),
        intentionIds: new Set(intentions.intentions.map(intention => intention.id)),
      })
      // Both stores write their records before this function awaits anything.
      const saves = [
        missions.applySyncReminders(split.reminders.saved, split.reminders.removed),
        intentions.applySyncIntentions(split.intentions.saved, split.intentions.removed),
      ]
      await Promise.all(saves)
      return { rejected: split.rejected }
    },
  })

  return {
    initialize: sync.initialize,
    dispose: sync.dispose,
    synchronizeRecords: sync.synchronize,
  }
})
