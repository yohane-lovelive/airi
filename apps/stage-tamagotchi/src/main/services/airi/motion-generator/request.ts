import type { MotionGeneratorConfigUpdate, MotionGeneratorGenerateInput } from '../../../../shared/eventa/motion-generator'

/**
 * Request rules for the motion generator service.
 *
 * These functions hold no Electron state, so they stay testable on their own.
 * The service in `./index` applies them around the stored settings.
 */

/** The address that Text-To-VRMA serves its local HTTP API on by default. */
export const defaultBaseUrl = 'http://127.0.0.1:8787'

/**
 * How long one generation can take.
 *
 * Text-To-VRMA takes seconds on a GPU and tens of seconds on a CPU. The first call also loads the model.
 */
export const generateTimeoutMs = 180_000

/** How long the health check can take. */
export const checkTimeoutMs = 5_000

/** The longest prompt that the service gets. A marker motion is a short phrase. */
const maxPromptLength = 200
const minDuration = 1
const maxDuration = 8
const defaultDuration = 3
const maxDailyLimit = 50

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** One stored setting of the motion generator. */
export interface MotionGeneratorStoredConfig {
  baseUrl: string
  token: string
  enabled: boolean
  dailyLimit: number
  /** The local day of {@link usedCount}, for example `2026-11-04`. */
  usedDay: string
  usedCount: number
}

export const defaultConfig: MotionGeneratorStoredConfig = {
  baseUrl: defaultBaseUrl,
  token: '',
  enabled: false,
  dailyLimit: 5,
  usedDay: '',
  usedCount: 0,
}

/**
 * Trims a user-entered address, and accepts only an address of this PC.
 *
 * Text-To-VRMA binds its API to 127.0.0.1. An address of another host would send the token there, so this refuses it.
 */
export function normalizeLoopbackUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  }
  catch {
    throw new Error(`"${value}" is not a valid URL.`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new Error('The motion generator address must start with http:// or https://.')
  if (!loopbackHosts.has(parsed.hostname))
    throw new Error('The motion generator must run on this PC: use 127.0.0.1, localhost, or [::1].')
  if (parsed.pathname !== '/' || parsed.search || parsed.hash)
    throw new Error('Enter the address without a path, for example http://127.0.0.1:8787.')

  return parsed.origin
}

/**
 * Applies one settings update to the stored settings.
 *
 * Every address is on this PC, so the token can stay when the port changes. An empty token clears it, and an absent
 * token keeps it.
 */
export function resolveConfigUpdate(current: MotionGeneratorStoredConfig, update: MotionGeneratorConfigUpdate): MotionGeneratorStoredConfig {
  const next = { ...current }
  if (update.baseUrl !== undefined)
    next.baseUrl = normalizeLoopbackUrl(update.baseUrl)
  if (update.token !== undefined)
    next.token = update.token.trim()
  if (update.enabled !== undefined)
    next.enabled = update.enabled
  if (update.dailyLimit !== undefined)
    next.dailyLimit = Math.min(maxDailyLimit, Math.max(1, Math.round(update.dailyLimit) || 1))
  return next
}

/** The local day of a time, for example `2026-11-04`. */
export function localDayOf(time: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`
}

/** The generations of `day`. A count of an earlier day is zero. */
export function usedOn(current: MotionGeneratorStoredConfig, day: string): number {
  return current.usedDay === day ? current.usedCount : 0
}

/**
 * The body of `POST /v1/motions`.
 *
 * ARDY runs locally, and the planner `none` needs no key of OpenAI, Claude, or Codex.
 */
export function generateBody(input: MotionGeneratorGenerateInput) {
  const prompt = input.prompt.trim().slice(0, maxPromptLength)
  if (!prompt)
    throw new Error('Describe the motion to generate.')
  const duration = Math.min(maxDuration, Math.max(minDuration, input.duration ?? defaultDuration))
  return { prompt, engine: 'ardy', planner: 'none', duration, format: 'vrma' }
}

/** Builds the URL of a path under the stored address. */
export function serviceUrl(baseUrl: string, path: '/health' | '/v1/motions'): string {
  return `${normalizeLoopbackUrl(baseUrl)}${path}`
}

/** Builds the error of a failed response, with the start of its body, so the owner sees the reason of the service. */
export async function toRequestError(response: Response): Promise<Error> {
  const text = (await response.text().catch(() => '')).trim().slice(0, 300)
  return new Error(`The motion generator answered ${response.status}${text ? `: ${text}` : ''}`)
}

/**
 * Checks that the data is a binary glTF file, which every `.vrma` file is.
 *
 * Returns:
 * - The data as bytes.
 */
export function toVrmaBytes(data: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(data)
  // A binary glTF file starts with the magic `glTF`.
  if (bytes.length < 12 || bytes[0] !== 0x67 || bytes[1] !== 0x6C || bytes[2] !== 0x54 || bytes[3] !== 0x46)
    throw new Error('The motion generator returned no .vrma file.')
  return bytes
}
