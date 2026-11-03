import type { ChatRequestOptions } from '@proj-airi/provider-inference'
import type {} from 'pinia-plugin-synced'

import { defineStore } from 'pinia'
import { shallowRef } from 'vue'

/**
 * How much the chat model reasons. `default` sends no request, so the provider or the model decides. `low`, `medium`,
 * and `high` turn reasoning on, and a provider with only on and off treats them all as on.
 */
export const REASONING_LEVELS = ['default', 'off', 'low', 'medium', 'high'] as const

export type ReasoningLevel = typeof REASONING_LEVELS[number]

/** The reasoning of autonomous speech: a level of its own, or `same` as the replies to the owner. */
export type AutonomousReasoningLevel = ReasoningLevel | 'same'

/** Which turns a request is for. Autonomous turns are small talk, commentary, and idle speech. */
export type ReasoningUse = 'reply' | 'autonomous'

function loadEnabled(key: string) {
  // Non-renderer runtimes have no durable settings owner. They use the product
  // default until a synchronized renderer snapshot arrives.
  if (typeof localStorage === 'undefined')
    return false

  return localStorage.getItem(`settings/consciousness/${key}`) === 'true'
}

function persistEnabled(key: string, value: boolean) {
  if (typeof localStorage === 'undefined')
    return

  localStorage.setItem(`settings/consciousness/${key}`, String(value))
}

function loadLevel<T extends string>(key: string, levels: readonly T[]): T | undefined {
  if (typeof localStorage === 'undefined')
    return undefined
  const stored = localStorage.getItem(`settings/consciousness/${key}`)
  return levels.find(level => level === stored)
}

function persistLevel(key: string, value: string) {
  if (typeof localStorage === 'undefined')
    return
  localStorage.setItem(`settings/consciousness/${key}`, value)
}

function loadReplyLevel(): ReasoningLevel {
  const stored = loadLevel('reasoning-level', REASONING_LEVELS)
  if (stored)
    return stored
  // NOTICE:
  // The old on and off switch keeps its requests: on was a medium effort, off was disabled.
  // Source: settings/consciousness/reasoning, written before step 5-0 of ADR 2026-10-28.
  // Removal condition: the release after the levels ship, when no device keeps the old key.
  return loadEnabled('reasoning') ? 'medium' : 'off'
}

/** The request options of a reasoning level. `default` has none, so the provider decides. */
export function chatRequestOptionsOf(level: ReasoningLevel): ChatRequestOptions | undefined {
  switch (level) {
    case 'default':
      return undefined
    case 'off':
      return { reasoning: 'disabled' }
    default:
      return { reasoning: 'enabled', effort: level }
  }
}

/**
 * Stores request policies for the consciousness module.
 *
 * Consciousness chat request preparation reads this state before inference.
 * Each provider maps the reasoning level to its own request fields.
 */
export const useConsciousnessSettingsStore = defineStore('consciousness-settings', () => {
  // Pinia owns live cross-window state. Only synchronized actions write the
  // durable value, so a follower cannot persist an uncommitted proposal.
  const reasoningLevel = shallowRef<ReasoningLevel>(loadReplyLevel())
  const autonomousReasoningLevel = shallowRef<AutonomousReasoningLevel>(loadLevel('autonomous-reasoning-level', [...REASONING_LEVELS, 'same'] as const) ?? 'same')
  const temperatureEnabled = shallowRef(loadEnabled('temperature-enabled'))
  const topPEnabled = shallowRef(loadEnabled('top-p-enabled'))

  async function setReasoningLevel(value: ReasoningLevel) {
    reasoningLevel.value = value
    persistLevel('reasoning-level', value)
  }

  async function setAutonomousReasoningLevel(value: AutonomousReasoningLevel) {
    autonomousReasoningLevel.value = value
    persistLevel('autonomous-reasoning-level', value)
  }

  async function setTemperatureEnabled(value: boolean) {
    temperatureEnabled.value = value
    persistEnabled('temperature-enabled', value)
  }

  async function setTopPEnabled(value: boolean) {
    topPEnabled.value = value
    persistEnabled('top-p-enabled', value)
  }

  /** The reasoning level of a turn. Autonomous speech follows the replies unless it has a level of its own. */
  function levelFor(use: ReasoningUse): ReasoningLevel {
    return use === 'autonomous' && autonomousReasoningLevel.value !== 'same' ? autonomousReasoningLevel.value : reasoningLevel.value
  }

  async function resetState() {
    await setReasoningLevel('off')
    await setAutonomousReasoningLevel('same')
    await setTemperatureEnabled(false)
    await setTopPEnabled(false)
  }

  return {
    reasoningLevel,
    autonomousReasoningLevel,
    temperatureEnabled,
    topPEnabled,
    setReasoningLevel,
    setAutonomousReasoningLevel,
    setTemperatureEnabled,
    setTopPEnabled,
    levelFor,
    resetState,
  }
}, {
  synced: {
    actions: ['resetState', 'setReasoningLevel', 'setAutonomousReasoningLevel', 'setTemperatureEnabled', 'setTopPEnabled'],
    state: true,
  },
})
