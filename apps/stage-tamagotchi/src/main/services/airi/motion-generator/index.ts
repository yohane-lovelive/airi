import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type { MotionGeneratorStoredConfig } from './request'

import { defineInvokeHandler } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import { boolean, number, object, string } from 'valibot'

import { motionGeneratorCheck, motionGeneratorGenerate, motionGeneratorGetConfig, motionGeneratorSetConfig } from '../../../../shared/eventa/motion-generator'
import { createConfig } from '../../../libs/electron/persistence'
import { toTokenPreview } from '../home-assistant/request'
import { checkTimeoutMs, defaultConfig, generateBody, generateTimeoutMs, localDayOf, resolveConfigUpdate, serviceUrl, toRequestError, toVrmaBytes, usedOn } from './request'

const configSchema = object({
  baseUrl: string(),
  token: string(),
  enabled: boolean(),
  dailyLimit: number(),
  usedDay: string(),
  usedCount: number(),
})

/**
 * Registers the motion generator service, which calls Text-To-VRMA on this PC.
 *
 * Use when:
 * - Electron main must own the address and the token of the generator
 * - The renderer needs a transport without the browser cross-origin rules, because Text-To-VRMA turns CORS off
 *
 * Expects:
 * - `context` is the Electron main IPC context
 *
 * Returns:
 * - Nothing. The handlers stay registered for the lifetime of the application.
 */
export function setupMotionGenerator(context: ReturnType<typeof createContext>['context']) {
  const config = createConfig('motion-generator', 'v1.json', configSchema, {
    default: defaultConfig,
    autoHeal: true,
  })
  config.setup()
  // One generation at a time. ARDY shares the GPU with the game of the owner.
  let generating = false
  // Settings is another window, so the main process keeps the reason of the last failure for it.
  let lastError: string | undefined

  function read() {
    return config.get() ?? defaultConfig
  }

  function toPublic(current: MotionGeneratorStoredConfig) {
    return {
      baseUrl: current.baseUrl,
      hasToken: Boolean(current.token),
      tokenPreview: toTokenPreview(current.token),
      enabled: current.enabled,
      dailyLimit: current.dailyLimit,
      usedToday: usedOn(current, localDayOf(new Date())),
      ...(lastError ? { lastError } : {}),
    }
  }

  async function call(path: '/health' | '/v1/motions', init: RequestInit, timeoutMs: number) {
    const current = read()
    if (!current.token)
      throw new Error('The motion generator has no access token yet. Enter the token of Text-To-VRMA in Settings.')
    const target = serviceUrl(current.baseUrl, path)
    let response: Response
    try {
      response = await fetch(target, {
        ...init,
        headers: { Authorization: `Bearer ${current.token}`, ...init.headers },
        signal: AbortSignal.timeout(timeoutMs),
      })
    }
    catch (error) {
      throw new Error(`Could not reach the motion generator at ${current.baseUrl}: ${errorMessageFrom(error) ?? 'unknown network error'}`)
    }
    if (!response.ok)
      throw await toRequestError(response)
    return response
  }

  defineInvokeHandler(context, motionGeneratorGetConfig, () => toPublic(read()))

  defineInvokeHandler(context, motionGeneratorSetConfig, (update) => {
    const next = resolveConfigUpdate(read(), update)
    config.update(next)
    return toPublic(next)
  })

  defineInvokeHandler(context, motionGeneratorCheck, async () => {
    await call('/health', { method: 'GET' }, checkTimeoutMs)
    return true as const
  })

  defineInvokeHandler(context, motionGeneratorGenerate, async (input) => {
    const current = read()
    if (!current.enabled)
      throw new Error('Motion generation is off.')
    const day = localDayOf(new Date())
    if (usedOn(current, day) >= current.dailyLimit)
      throw new Error(`Motion generation reached the limit of ${current.dailyLimit} for today.`)
    if (generating)
      throw new Error('Another motion is being generated.')

    generating = true
    try {
      const body = generateBody(input)
      const response = await call('/v1/motions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, generateTimeoutMs)
      const bytes = toVrmaBytes(await response.arrayBuffer())
      // Only a clip counts, so a stopped service does not use up the day.
      const latest = read()
      config.update({ ...latest, usedDay: day, usedCount: usedOn(latest, day) + 1 })
      lastError = undefined
      return bytes
    }
    catch (error) {
      lastError = errorMessageFrom(error) ?? 'unknown error'
      throw error
    }
    finally {
      generating = false
    }
  })
}
