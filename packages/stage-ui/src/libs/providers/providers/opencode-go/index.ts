import type { ChatRequestOptions, GenerationRequest } from '@proj-airi/provider-inference'

import type { ModelInfo, ProviderDefinition } from '../../types'

import { isStageCapacitor, isStageTamagotchi } from '@proj-airi/stage-shared'
import { providerRelayBaseUrl } from '@proj-airi/stage-shared/provider-relay'
import { createOpenAI } from '@xsai-ext/providers/create'
import { array, number, object, optional, parse, string } from 'valibot'
import { z } from 'zod'

import { ProviderValidationCheck } from '../../types'
import { createOpenAICompatibleValidators } from '../../validators'
import { defineProvider } from '../registry'

const configSchema = z.object({
  apiKey: z.string('API Key'),
})

type Config = z.input<typeof configSchema>

/** The fields of the model list of the server that the settings and the chat use. */
const catalogSchema = object({
  data: array(object({
    id: string(),
    name: optional(string()),
    description: optional(string()),
    /** The MIME types that the model reads, for example `text` and `image/png`. */
    modalities: optional(object({ input: optional(array(string())) })),
    limit: optional(object({ context: optional(number()) })),
  })),
})

/**
 * How each model reads a reasoning request.
 *
 * - `effort`: the model reads `reasoning_effort`, and `none` turns reasoning off.
 * - `thinking`: the model reads `thinking.type`.
 * - `effort-minimal`: the model reads `reasoning_effort`, but it cannot turn reasoning off. `minimal` is its lowest.
 *
 * The values come from requests to the server on 2026-11-13. Only the request that turns reasoning off was measured.
 * A wrong field gives HTTP 400, and the model list of the server does not tell the field. So a model that is not here
 * gets no reasoning field and reasons as the server decides.
 */
const reasoningForms: Record<string, 'effort' | 'thinking' | 'effort-minimal'> = {
  'gpt-6-luna': 'effort',
  'gpt-5.6-luna': 'effort',
  'claude-haiku-5-5': 'effort',
  'glm-5.3-flash': 'effort',
  'qwen3.8-flash': 'effort',
  'deepseek-v4.1-flash': 'thinking',
  'mimo-v2.6-pro': 'thinking',
  'longcat-2.5-free': 'thinking',
  'minimax-m3.1-flash': 'effort-minimal',
}

function reasoningFieldsOf(model: string, options: ChatRequestOptions | undefined) {
  if (!options)
    return {}
  const enabled = options.reasoning === 'enabled'
  switch (reasoningForms[model]) {
    case 'effort':
      return { reasoningEffort: enabled ? options.effort ?? 'medium' : 'none' }
    case 'effort-minimal':
      return { reasoningEffort: enabled ? options.effort ?? 'medium' : 'minimal' }
    case 'thinking':
      return { thinking: { type: options.reasoning } }
    default:
      return {}
  }
}

/** The page reaches the server through the relay of its host, because a browser cannot call the server. */
function relayBaseUrl() {
  return providerRelayBaseUrl('opencode-go', isStageTamagotchi() ? 'desktop' : { origin: globalThis.location.origin })
}

/**
 * Reads the model list of the server. It tells which models read images, so the owner does not set that by hand for
 * each model.
 */
async function listModels(config: Config): Promise<ModelInfo[]> {
  const response = await fetch(`${relayBaseUrl()}models`, { headers: { Authorization: `Bearer ${config.apiKey}` } })
  if (!response.ok)
    throw new Error(`The model list of OpenCode Go failed with HTTP ${response.status}.`)

  return parse(catalogSchema, await response.json()).data.map((model) => {
    const input = model.modalities?.input
    return {
      id: model.id,
      name: model.name ?? model.id,
      provider: 'opencode-go',
      description: model.description,
      contextLength: model.limit?.context,
      // `image/png` becomes `image`, the form that the chat reads.
      inputModalities: input ? [...new Set(input.map(kind => kind.split('/')[0]))] : undefined,
      metadata: input ? { abilities: { vision: input.some(kind => kind.startsWith('image/')) } } : undefined,
    }
  })
}

type Validators = NonNullable<ProviderDefinition<Config>['validators']>

/**
 * The shared validators read the base URL from the config. This provider keeps no base URL there, because the URL of
 * the relay differs between the desktop app and the web app, and the config can sync between them. So each validator
 * gets the relay URL of the app that runs it.
 */
function relayValidators(): Validators {
  const shared = createOpenAICompatibleValidators<Config & { baseUrl?: string }>({
    checks: [ProviderValidationCheck.Connectivity, ProviderValidationCheck.ModelList, ProviderValidationCheck.ChatCompletions],
  })
  const atRelay = (config: Config) => ({ ...config, baseUrl: relayBaseUrl() })
  return {
    validateConfig: shared?.validateConfig?.map((create): NonNullable<Validators['validateConfig']>[number] => async (context) => {
      const validator = await create(context)
      return { ...validator, validator: (config, options) => validator.validator(atRelay(config), options) }
    }),
    validateProvider: shared?.validateProvider?.map((create): NonNullable<Validators['validateProvider']>[number] => async (context) => {
      const validator = await create(context)
      return { ...validator, validator: (config, provider, extra, options) => validator.validator(atRelay(config), provider, extra, options) }
    }),
  }
}

/**
 * OpenCode Go, a subscription for hosted models with an OpenAI-compatible API.
 *
 * The definition differs from `openai-compatible` in two points. Each request goes through the provider relay, which
 * adds the session header of the server. And the reasoning field follows the model, not one choice for the provider.
 */
export const providerOpenCodeGo = defineProvider<Config, 'opencode-go'>({
  id: 'opencode-go',
  name: 'OpenCode Go',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.opencode-go.title'),
  description: 'opencode.ai',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.opencode-go.description'),
  tasks: ['chat'],
  capabilities: { chat: { reasoning: { modes: ['enabled', 'disabled'] } } },
  icon: 'i-solar:code-square-bold-duotone',
  // The mobile app has no host that runs the relay.
  isAvailableBy: () => !isStageCapacitor(),

  createProviderConfig: ({ t }) => configSchema.extend({
    apiKey: configSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
  }),
  createProvider(config) {
    const provider = createOpenAI(config.apiKey, relayBaseUrl())
    return {
      model: provider.model,
      generation(model: string, options?: ChatRequestOptions): GenerationRequest {
        return {
          protocol: 'chat-completions',
          config: { ...provider.chat(model), ...reasoningFieldsOf(model, options) },
        }
      },
    }
  },

  validationRequiredWhen(config) {
    return !!config.apiKey?.trim()
  },
  validators: relayValidators(),
  extraMethods: {
    listModels,
  },
})
