import type { InitiativeSettings } from '@proj-airi/core-agent'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { clamp } from 'es-toolkit'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/** The limits that Settings offer. Code keeps each stored value inside them. */
export const INITIATIVE_LIMITS = {
  minIdleIntervalMinutes: 1,
  maxIdleIntervalMinutes: 240,
  minDailyTurnBudget: 1,
  maxDailyTurnBudget: 1000,
} as const

/** Reads `HH:mm` as minutes since midnight. Resolves to `undefined` for any other text. */
function minutesOf(time: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (!match)
    return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined
}

/**
 * The owner settings of autonomous speech: the character starts to talk without an owner message.
 * The device keeps them. All are off or conservative by default.
 *
 * Use when:
 * - Settings show or change autonomous speech.
 * - The initiative runner reads the policy settings.
 *
 * Returns:
 * - The stored values, `supported` for apps that run the policy, and `settings` for `resolveInitiativeOptions`.
 */
export const useInitiativeStore = defineStore('initiative', () => {
  /** Whether the character starts to talk on its own. Off by default, because each turn is one model call. */
  const enabled = useLocalStorageManualReset<boolean>('initiative/enabled', false)
  /** With no events, the character talks about this often. */
  const idleIntervalMinutes = useLocalStorageManualReset<number>('initiative/idle-interval-minutes', 15)
  /** The maximum count of autonomous turns in one day. A silent turn counts too. */
  const dailyTurnBudget = useLocalStorageManualReset<number>('initiative/daily-turn-budget', 200)
  const quietHoursEnabled = useLocalStorageManualReset<boolean>('initiative/quiet-hours-enabled', false)
  /** The start of the quiet hours, `HH:mm`. A range can pass midnight. */
  const quietHoursStart = useLocalStorageManualReset<string>('initiative/quiet-hours-start', '23:00')
  /** The end of the quiet hours, `HH:mm`. */
  const quietHoursEnd = useLocalStorageManualReset<string>('initiative/quiet-hours-end', '07:00')
  /**
   * Whether this app runs autonomous speech. The initiative runner sets it when an app initializes it, so Settings of
   * an app without a runner, for example the mobile app, can say that the feature does not run there.
   */
  const supported = ref(false)

  /** The settings for the policy. Each value stays inside its limits, so a stored value from an older build still works. */
  const settings = computed<InitiativeSettings>(() => {
    const { minIdleIntervalMinutes, maxIdleIntervalMinutes, minDailyTurnBudget, maxDailyTurnBudget } = INITIATIVE_LIMITS
    const startMinutes = minutesOf(quietHoursStart.value)
    const endMinutes = minutesOf(quietHoursEnd.value)
    return {
      dailyTurnBudget: Math.round(clamp(dailyTurnBudget.value, minDailyTurnBudget, maxDailyTurnBudget)),
      modes: { idle: { boredomIntervalMs: clamp(idleIntervalMinutes.value, minIdleIntervalMinutes, maxIdleIntervalMinutes) * 60_000 } },
      ...(quietHoursEnabled.value && startMinutes !== undefined && endMinutes !== undefined ? { quietHours: { startMinutes, endMinutes } } : {}),
    }
  })

  function resetState() {
    enabled.reset()
    idleIntervalMinutes.reset()
    dailyTurnBudget.reset()
    quietHoursEnabled.reset()
    quietHoursStart.reset()
    quietHoursEnd.reset()
  }

  return {
    enabled,
    idleIntervalMinutes,
    dailyTurnBudget,
    quietHoursEnabled,
    quietHoursStart,
    quietHoursEnd,
    supported,
    settings,
    resetState,
  }
})
