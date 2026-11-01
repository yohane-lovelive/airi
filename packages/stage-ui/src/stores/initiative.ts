import type { InitiativeSettings, TalkControl, TalkLevelRequest } from '@proj-airi/core-agent'

import type { TalkLevelApplyResult } from '../tools/initiative'

import { activeTalkControl, applyTalkLevel, talkControlEffect } from '@proj-airi/core-agent'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { clamp } from 'es-toolkit'
import { defineStore } from 'pinia'
import { ref } from 'vue'

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
 * - The talk level tool applies the owner's words, for example "be quiet for 30 minutes".
 *
 * Returns:
 * - The stored values, `supported` for apps that run the policy, and `settingsAt` for `resolveInitiativeOptions`.
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
   * The temporary changes that the owner asked for with words. Each part has an end time, so the device keeps them
   * across a restart, and an ended part has no effect.
   */
  const talkControl = useLocalStorageManualReset<TalkControl>('initiative/talk-control', {})
  /**
   * Whether this app runs autonomous speech. The initiative runner sets it when an app initializes it, so Settings of
   * an app without a runner, for example the mobile app, can say that the feature does not run there.
   */
  const supported = ref(false)

  /** The idle interval of Settings, inside its limits, so a stored value from an older build still works. */
  function clampedIdleIntervalMinutes() {
    return clamp(idleIntervalMinutes.value, INITIATIVE_LIMITS.minIdleIntervalMinutes, INITIATIVE_LIMITS.maxIdleIntervalMinutes)
  }

  /** The settings for the policy at `now`, with the owner's temporary changes. Each value stays inside its limits. */
  function settingsAt(now: number): InitiativeSettings {
    const { minDailyTurnBudget, maxDailyTurnBudget } = INITIATIVE_LIMITS
    const startMinutes = minutesOf(quietHoursStart.value)
    const endMinutes = minutesOf(quietHoursEnd.value)
    const { quietUntil, idleIntervalFactor } = talkControlEffect(talkControl.value, now)
    return {
      dailyTurnBudget: Math.round(clamp(dailyTurnBudget.value, minDailyTurnBudget, maxDailyTurnBudget)),
      modes: { idle: { boredomIntervalMs: clampedIdleIntervalMinutes() * idleIntervalFactor * 60_000 } },
      ...(quietHoursEnabled.value && startMinutes !== undefined && endMinutes !== undefined ? { quietHours: { startMinutes, endMinutes } } : {}),
      ...(quietUntil !== undefined ? { quietUntil } : {}),
    }
  }

  /**
   * Applies a talk level request from the owner. A permanent change writes the idle interval of Settings, inside its
   * limits. On a refusal, `reason` tells the model what to change.
   */
  function applyTalkRequest(request: TalkLevelRequest): TalkLevelApplyResult {
    const now = Date.now()
    const result = applyTalkLevel(talkControl.value, request, now)
    if (!result.ok)
      return result
    talkControl.value = result.control
    if (result.permanentFactor !== undefined) {
      const { minIdleIntervalMinutes, maxIdleIntervalMinutes } = INITIATIVE_LIMITS
      idleIntervalMinutes.value = Math.round(clamp(clampedIdleIntervalMinutes() * result.permanentFactor, minIdleIntervalMinutes, maxIdleIntervalMinutes))
    }
    return { ok: true, control: activeTalkControl(result.control, now), idleIntervalMinutes: clampedIdleIntervalMinutes() }
  }

  /** Ends every temporary change that the owner asked for. */
  function resetTalkControl() {
    talkControl.reset()
  }

  function resetState() {
    enabled.reset()
    idleIntervalMinutes.reset()
    dailyTurnBudget.reset()
    quietHoursEnabled.reset()
    quietHoursStart.reset()
    quietHoursEnd.reset()
    talkControl.reset()
  }

  return {
    enabled,
    idleIntervalMinutes,
    dailyTurnBudget,
    quietHoursEnabled,
    quietHoursStart,
    quietHoursEnd,
    talkControl,
    supported,
    settingsAt,
    applyTalkRequest,
    resetTalkControl,
    resetState,
  }
})
