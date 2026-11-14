import { defineInvokeEventa } from '@moeru/eventa'

/**
 * The motion generator settings the renderer can read back.
 *
 * The generator is Text-To-VRMA on this PC. The access token never travels to the renderer, like the Home Assistant
 * token. The main process also keeps the count of today, so every window sees the same limit.
 */
export interface MotionGeneratorPublicConfig {
  /** The address of the local HTTP API, without a trailing slash. */
  baseUrl: string
  hasToken: boolean
  /** The stored token with its middle removed, for the settings placeholder. */
  tokenPreview: string
  /** Whether a marker without a matching clip starts a generation. */
  enabled: boolean
  /** The most generations in one day. */
  dailyLimit: number
  /** The generations of today. */
  usedToday: number
  /** Why the last generation failed, until one succeeds. The main process keeps it in memory only. */
  lastError?: string
}

/** The settings the renderer writes. An absent field keeps the stored value. */
export interface MotionGeneratorConfigUpdate {
  baseUrl?: string
  /** Omit to keep the stored token. Send an empty string to clear it. */
  token?: string
  enabled?: boolean
  dailyLimit?: number
}

/** One generation. */
export interface MotionGeneratorGenerateInput {
  /** What the motion shows, for example the `motion` of an `ACT` marker. */
  prompt: string
  /** The length of the clip in seconds. */
  duration?: number
}

export const motionGeneratorGetConfig = defineInvokeEventa<MotionGeneratorPublicConfig>('eventa:invoke:motion-generator:get-config')
export const motionGeneratorSetConfig = defineInvokeEventa<MotionGeneratorPublicConfig, MotionGeneratorConfigUpdate>('eventa:invoke:motion-generator:set-config')
/** Asks the service whether it answers. It throws with the reason when it does not. */
export const motionGeneratorCheck = defineInvokeEventa<true>('eventa:invoke:motion-generator:check')
/** Generates one clip, and returns the `.vrma` data. */
export const motionGeneratorGenerate = defineInvokeEventa<Uint8Array, MotionGeneratorGenerateInput>('eventa:invoke:motion-generator:generate')
