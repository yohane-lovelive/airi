import { errorMessageFrom } from '@moeru/std'
import { defineStore } from 'pinia'
import { shallowRef } from 'vue'

import { useMotionLibraryStore } from './motion-library'
import { useUsageStore } from './usage'

/** The settings of a motion generator, as the app that owns it reports them. */
export interface MotionGeneratorStatus {
  baseUrl: string
  hasToken: boolean
  /** The stored token with its middle removed. The token itself stays with the app. */
  tokenPreview: string
  enabled: boolean
  dailyLimit: number
  usedToday: number
  /** Why the last generation failed, until one succeeds. */
  lastError?: string
}

/** A change of the settings. An absent field keeps the stored value, and an empty token clears it. */
export interface MotionGeneratorSettingsUpdate {
  baseUrl?: string
  token?: string
  enabled?: boolean
  dailyLimit?: number
}

/**
 * A motion generator that an app gives the library, for example Text-To-VRMA through the main process of the desktop
 * app. The web app gives none.
 */
export interface MotionGeneratorConnection {
  getConfig: () => Promise<MotionGeneratorStatus>
  setConfig: (update: MotionGeneratorSettingsUpdate) => Promise<MotionGeneratorStatus>
  /** Throws with the reason when the generator does not answer. */
  check: () => Promise<unknown>
  /** Generates one clip, and returns the `.vrma` data. */
  generate: (input: { prompt: string, duration?: number }) => Promise<Uint8Array>
}

/** At most this many motions wait. A marker of a full queue starts nothing. */
const MAX_QUEUE = 3
/** A clip that the owner asked for plays when it is ready within this time. A later clip only joins the library. */
const PLAY_WINDOW_MS = 60_000
/** The usage records name the generator with this model. ARDY with no planner uses no tokens of a chat model. */
const GENERATOR_MODEL = 'text-to-vrma'

/** A request to play a clip on the stage. `at` tells two requests for the same clip apart. */
export interface MotionPlayRequest {
  id: string
  at: number
}

/** The answer to an owner request: the generation waits in the queue, or the reason why none can run. */
export type OwnerMotionRequestResult = { ok: true } | { ok: false, reason: string }

/**
 * Generates the clips that the library lacks.
 *
 * - A marker whose motion matches no clip asks for a clip. One generation runs at a time, and only while no chat turn
 *   runs, because the generator shares the GPU of the PC.
 * - The app that owns the generator keeps the settings and the count of the day, so every window sees the same limit.
 * - A motion is tried once in each run of the app, so a failure does not repeat.
 * - A motion that the owner asked for goes first, and its clip plays when it is ready within a minute.
 *
 * Use when:
 * - The stage gets a marker motion without a clip, or Settings shows the generator.
 *
 * Expects:
 * - The app calls {@link connect} at start. Without a connection, nothing generates.
 */
export const useMotionGenerationStore = defineStore('motion-generation', () => {
  const library = useMotionLibraryStore()
  const usage = useUsageStore()

  const connection = shallowRef<MotionGeneratorConnection>()
  const queue = shallowRef<readonly string[]>([])
  /** The motion that generates now. */
  const running = shallowRef<string>()
  const busy = shallowRef(false)
  /** The last clip that the stage plays. The stage of this window watches it. */
  const playRequest = shallowRef<MotionPlayRequest>()
  const tried = new Set<string>()
  /** The motions that the owner asked for, and when. */
  const requestedAt = new Map<string, number>()

  function connect(next: MotionGeneratorConnection) {
    connection.value = next
  }

  /** Tells whether a chat turn runs. A generation waits for the end of the turn. */
  function setBusy(value: boolean) {
    busy.value = value
    if (!value)
      void pump()
  }

  /**
   * Asks for a clip of `motion`.
   *
   * @returns whether the motion joined the queue.
   */
  function request(motion: string) {
    const text = motion.trim()
    const key = text.toLowerCase()
    if (!connection.value || !text || tried.has(key) || running.value === key || queue.value.some(waiting => waiting.toLowerCase() === key) || queue.value.length >= MAX_QUEUE)
      return false
    queue.value = [...queue.value, text]
    void pump()
    return true
  }

  /**
   * Asks for a clip of a motion that the owner asked for. It goes first in the queue, and the clip plays when it is
   * ready within a minute.
   *
   * @returns the reason when no generation can run, for the model to tell the owner.
   */
  async function requestForOwner(motion: string): Promise<OwnerMotionRequestResult> {
    const generator = connection.value
    const text = motion.trim()
    const key = text.toLowerCase()
    if (!generator)
      return { ok: false, reason: 'Motion generation needs the desktop app with Text-To-VRMA.' }
    if (!text)
      return { ok: false, reason: 'Describe the motion.' }
    if (tried.has(key))
      return { ok: false, reason: 'A generation of this motion failed earlier in this run of the app.' }
    const status = await generator.getConfig()
    if (!status.enabled)
      return { ok: false, reason: 'Motion generation is off. The owner can turn it on in Settings > Modules > Motions.' }
    if (!status.hasToken)
      return { ok: false, reason: 'Motion generation has no token of Text-To-VRMA. The owner can enter it in Settings > Modules > Motions.' }
    if (status.usedToday >= status.dailyLimit)
      return { ok: false, reason: `Motion generation reached the limit of ${status.dailyLimit} clips for today.` }

    requestedAt.set(key, Date.now())
    if (running.value !== key) {
      const others = queue.value.filter(waiting => waiting.toLowerCase() !== key)
      queue.value = [text, ...others].slice(0, MAX_QUEUE)
      void pump()
    }
    return { ok: true }
  }

  async function generateOne(generator: MotionGeneratorConnection, text: string) {
    const status = await generator.getConfig()
    if (!status.enabled || status.usedToday >= status.dailyLimit) {
      queue.value = []
      return
    }
    tried.add(text.toLowerCase())
    const bytes = await generator.generate({ prompt: text })
    const entry = await library.addGenerated(text, bytes.slice().buffer)
    if (!entry)
      throw new Error('The generated clip moves no part of the upper body.')
    const asked = requestedAt.get(text.toLowerCase())
    if (asked !== undefined && Date.now() - asked <= PLAY_WINDOW_MS)
      playRequest.value = { id: entry.id, at: Date.now() }
    await usage.record({ purpose: 'motion', model: GENERATOR_MODEL, at: Date.now(), calls: 1, tokens: { input: 0, output: 0, total: 0 }, images: 0 })
  }

  async function pump() {
    const generator = connection.value
    const text = queue.value[0]
    if (!generator || text === undefined || running.value !== undefined || busy.value)
      return
    queue.value = queue.value.slice(1)
    running.value = text.toLowerCase()
    try {
      await generateOne(generator, text)
    }
    catch (error) {
      // The main process keeps the reason for Settings. The console keeps it for the stage window.
      console.warn('[motion-generation] Failed to generate a motion:', errorMessageFrom(error) ?? 'unknown error')
    }
    finally {
      requestedAt.delete(text.toLowerCase())
      running.value = undefined
      void pump()
    }
  }

  return {
    connection,
    queue,
    running,
    playRequest,
    connect,
    setBusy,
    request,
    requestForOwner,
  }
})
