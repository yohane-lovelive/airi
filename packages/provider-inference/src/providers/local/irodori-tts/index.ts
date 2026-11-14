import type { VoiceInfo } from '../../../types'
import type { IrodoriServerConfig, IrodoriSynthesisOptions } from './server'

import { errorMessageFrom } from '@moeru/std'
import { z } from 'zod'

import { defineProvider } from '../../registry'
import { absoluteUrlError, readSpeechRequest } from '../speech-engine'
import {
  fetchIrodoriHealth,
  fetchIrodoriModels,
  fetchIrodoriVoices,
  IRODORI_CLIP_ID_PREFIX,
  resolveIrodoriClipPaths,
  synthesizeIrodoriSpeech,
} from './server'

export * from './reference-voices'
export * from './server'

const DEFAULT_BASE_URL = 'http://localhost:8088/v1/'

/** The model id of the server when `IRODORI_MODEL_NAME` is not set. */
const DEFAULT_MODEL = 'irodori-tts'

/**
 * `generateSpeech` builds a URL from this before it calls the injected `fetch`.
 * The adapter ignores the URL, so the value only has to parse.
 */
const SENTINEL_BASE_URL = 'http://irodori-tts.invalid/v1/'

/** Voice ids of AIRI reference voices start with this prefix. A server voice id has no colon. */
export const IRODORI_REFERENCE_VOICE_PREFIX = 'reference:'

/** How long the reachability check waits. A running server answers `/health` at once. */
const REACHABILITY_TIMEOUT_MS = 5_000

/** How often the reachability check runs again. VOICEVOX declares the same interval. */
const REACHABILITY_INTERVAL_MS = 15_000

const irodoriReferenceClipSchema = z.object({
  /** The voice id of the clip on the server. It starts with {@link IRODORI_CLIP_ID_PREFIX}. */
  id: z.string(),
  /** The file name that the owner picked. */
  name: z.string(),
  /** The length of the clip, measured when it was added. */
  seconds: z.number().default(0),
})

const irodoriReferenceVoiceSchema = z.object({
  /** The clips, in the order in which the server joins them. */
  clips: z.array(irodoriReferenceClipSchema).default([]),
  id: z.string(),
  name: z.string(),
})

const irodoriVoiceSettingsSchema = z.object({
  /** Words about the voice, for example its age, mood, and distance. Empty sends no caption. */
  caption: z.string().default(''),
  /** Sampling steps. Zero keeps the default of the server, which suits the loaded checkpoint. */
  numSteps: z.number().default(0),
  speed: z.number().default(1),
})

const irodoriConfigSchema = z.object({
  apiKey: z.string().default(''),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  referenceVoices: z.array(irodoriReferenceVoiceSchema).default([]),
  voiceSettings: irodoriVoiceSettingsSchema.default({ caption: '', numSteps: 0, speed: 1 }),
})

export type IrodoriTtsConfig = z.input<typeof irodoriConfigSchema>
export type IrodoriReferenceVoice = z.output<typeof irodoriReferenceVoiceSchema>
export type IrodoriReferenceClip = z.output<typeof irodoriReferenceClipSchema>

/** The server address and key of a saved configuration. A configuration without an address uses the default. */
export function irodoriServerConfigOf(config: Pick<IrodoriTtsConfig, 'apiKey' | 'baseUrl'>): IrodoriServerConfig {
  return { apiKey: config.apiKey, baseUrl: config.baseUrl?.trim() || DEFAULT_BASE_URL }
}

/** Builds the `irodori` options and the voice field of one request. */
export async function resolveIrodoriVoice(config: IrodoriTtsConfig, voice: string, signal?: AbortSignal): Promise<{ irodori: IrodoriSynthesisOptions, voice?: string }> {
  const settings = config.voiceSettings
  const irodori: IrodoriSynthesisOptions = {}
  const caption = settings?.caption?.trim()
  if (caption)
    irodori.caption = caption
  if (settings?.numSteps && settings.numSteps > 0)
    irodori.num_steps = Math.round(settings.numSteps)

  if (!voice.startsWith(IRODORI_REFERENCE_VOICE_PREFIX))
    return { irodori, voice }

  const id = voice.slice(IRODORI_REFERENCE_VOICE_PREFIX.length)
  const reference = config.referenceVoices?.find(item => item.id === id)
  if (!reference?.clips?.length)
    throw new Error('The reference voice has no clips. Add clips in the Irodori-TTS settings.')

  // The server ignores `voice` when the request names reference clips.
  irodori.ref_wavs = await resolveIrodoriClipPaths(irodoriServerConfigOf(config), reference.clips.map(clip => clip.id), { signal })
  return { irodori }
}

function referenceVoiceInfo(reference: z.input<typeof irodoriReferenceVoiceSchema>): VoiceInfo {
  return {
    description: `${reference.clips?.length ?? 0} reference clips`,
    id: `${IRODORI_REFERENCE_VOICE_PREFIX}${reference.id}`,
    languages: [{ code: 'ja', title: 'Japanese' }],
    name: reference.name,
    provider: 'irodori-tts',
  }
}

export const providerIrodoriTts = defineProvider<IrodoriTtsConfig, 'irodori-tts'>({
  id: 'irodori-tts',
  name: 'Irodori-TTS',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.irodori-tts.title'),
  description: 'github.com/Aratako/Irodori-TTS',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.irodori-tts.description'),
  tasks: ['text-to-speech'],
  icon: 'i-lobe-icons:speaker',
  requiresCredentials: false,
  createProviderConfig: () => irodoriConfigSchema,
  createProvider(config) {
    return {
      speech: () => ({
        baseURL: SENTINEL_BASE_URL,
        fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
          const { input, model, voice } = readSpeechRequest(init)
          const signal = init?.signal ?? undefined
          const resolved = await resolveIrodoriVoice(config, voice, signal)

          return await synthesizeIrodoriSpeech(irodoriServerConfigOf(config), {
            input,
            model: model || DEFAULT_MODEL,
            speed: config.voiceSettings?.speed ?? 1,
            ...resolved,
          }, { signal })
        },
        model: DEFAULT_MODEL,
      }),
    }
  },
  validationRequiredWhen: config => Boolean(config.baseUrl?.trim()),
  validators: {
    validateConfig: [
      ({ t }) => ({
        id: 'irodori-tts:check-config',
        name: t('settings.pages.providers.catalog.edit.validators.openai-compatible.check-config.title'),
        validator: async (config) => {
          const reason = absoluteUrlError(config.baseUrl?.trim() ?? '', DEFAULT_BASE_URL)
          if (reason)
            return { errors: [{ error: new Error(reason) }], reason, reasonKey: '', valid: false }

          return { errors: [], reason: '', reasonKey: '', valid: true }
        },
      }),
    ],
    // `getProviderValidationIntervalMs` reads schedules only from `validateProvider`.
    validateProvider: [
      ({ t }) => ({
        id: 'irodori-tts:check-reachability',
        name: t('settings.pages.providers.catalog.edit.validators.openai-compatible.check-connectivity.title'),
        schedule: {
          intervalMs: REACHABILITY_INTERVAL_MS,
          mode: 'interval',
        },
        validator: async (config) => {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS)
          try {
            await fetchIrodoriHealth(irodoriServerConfigOf(config), { signal: controller.signal })
            return { errors: [], reason: '', reasonKey: '', valid: true }
          }
          catch (error) {
            const reason = `Cannot reach Irodori-TTS-Server: ${errorMessageFrom(error) ?? 'Unknown error'}\n\nMake sure the server is running and that the Base URL matches its port.`
            return { errors: [{ error }], reason, reasonKey: '', valid: false }
          }
          finally {
            clearTimeout(timeout)
          }
        },
      }),
    ],
  },
  extraMethods: {
    listModels: async (config) => {
      const ids = await fetchIrodoriModels(irodoriServerConfigOf(config)).catch(() => [DEFAULT_MODEL])
      return (ids.length ? ids : [DEFAULT_MODEL]).map(id => ({
        contextLength: 0,
        deprecated: false,
        description: '',
        id,
        name: id,
        provider: 'irodori-tts',
      }))
    },
    voiceCatalogConfig: ({ apiKey, baseUrl, referenceVoices }) => ({ apiKey, baseUrl, referenceVoices }),
    listVoices: async (config, _provider, _model, signal) => {
      const references = (config.referenceVoices ?? [])
        .filter(reference => (reference.clips?.length ?? 0) > 0)
        .map(referenceVoiceInfo)
      // Uploaded clips belong to the reference voices above. Listing them again
      // offers a one-clip voice for each of them.
      const serverVoices = (await fetchIrodoriVoices(irodoriServerConfigOf(config), { signal }))
        .filter(voice => !voice.id.startsWith(IRODORI_CLIP_ID_PREFIX))
        .map(voice => ({
          description: voice.no_ref ? 'No reference. The caption sets the voice.' : '',
          id: voice.id,
          languages: [{ code: 'ja', title: 'Japanese' }],
          name: voice.id,
          provider: 'irodori-tts',
        }))

      return [...references, ...serverVoices]
    },
  },
})
