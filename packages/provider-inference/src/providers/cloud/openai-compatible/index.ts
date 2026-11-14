import type { ChatRequestOptions, GenerationRequest, ResponsesConfig } from '../../../types'

import { createOpenAI } from '@xsai-ext/providers/create'
import { z } from 'zod'

import { compatibleProtocols, generationProtocolOptions } from '../../../generation'
import { ProviderValidationCheck } from '../../../types'
import { createOpenAICompatibleValidators } from '../../../validators'
import { defineProvider } from '../../registry'

const configSchema = z.object({
  api: z.enum(compatibleProtocols.supportedProtocols).default(compatibleProtocols.defaultProtocol),
  apiKey: z
    .string('API Key')
    .optional(),
  baseUrl: z
    .string('Base URL')
    .optional()
    .default('https://api.openai.com/v1'),
  /**
   * How the server reads a reasoning request. Compatible servers differ, and an unknown field can fail a request, so the
   * default sends nothing.
   */
  reasoningControl: z.enum(['none', 'thinking', 'reasoning-effort']).optional().default('none'),
})

type Config = z.input<typeof configSchema>

export const providerOpenAICompatible = defineProvider<Config, 'openai-compatible'>({
  id: 'openai-compatible',
  order: 4,
  name: 'OpenAI Compatible',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.openai-compatible.title'),
  description: 'OpenAI-compatible chat APIs with API key authentication.',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.openai-compatible.description'),
  tasks: ['chat'],
  capabilities: { chat: { generation: compatibleProtocols, reasoning: { modes: ['enabled', 'disabled'] } } },
  icon: 'i-lobe-icons:openai',

  createProviderConfig: ({ t }) => configSchema.extend({
    api: configSchema.shape.api.meta({
      type: 'select',
      options: generationProtocolOptions(compatibleProtocols),
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-protocol.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-protocol.description'),
    }),
    apiKey: configSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: configSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
    reasoningControl: configSchema.shape.reasoningControl.meta({
      type: 'select',
      labelLocalized: t('settings.pages.providers.provider.openai-compatible.fields.field.reasoning-control.label'),
      descriptionLocalized: t('settings.pages.providers.provider.openai-compatible.fields.field.reasoning-control.description'),
      options: [
        { label: t('settings.pages.providers.provider.openai-compatible.fields.field.reasoning-control.options.none'), value: 'none' },
        { label: t('settings.pages.providers.provider.openai-compatible.fields.field.reasoning-control.options.thinking'), value: 'thinking' },
        { label: t('settings.pages.providers.provider.openai-compatible.fields.field.reasoning-control.options.reasoning-effort'), value: 'reasoning-effort' },
      ],
    }),
  }),
  createProvider(config) {
    const provider = createOpenAI(config.apiKey ?? '', config.baseUrl)
    return {
      model: provider.model,
      generation(model: string, options?: ChatRequestOptions): GenerationRequest {
        const request = provider.chat(model)
        const control = options ? config.reasoningControl ?? 'none' : 'none'
        const effort = options?.reasoning === 'enabled' ? options.effort ?? 'medium' : 'none'
        switch (config.api ?? compatibleProtocols.defaultProtocol) {
          case 'responses': {
            const responseConfig: ResponsesConfig = { ...request }
            // The Responses API has only the effort form.
            if (control !== 'none')
              responseConfig.reasoning = { effort }
            return { protocol: 'responses', config: responseConfig, webSearch: false }
          }
          case 'chat-completions':
            return {
              protocol: 'chat-completions',
              config: {
                ...request,
                // DeepSeek-style servers switch thinking on and off. OpenAI-style servers read an effort.
                ...(control === 'thinking' && options ? { thinking: { type: options.reasoning } } : {}),
                ...(control === 'reasoning-effort' ? { reasoningEffort: effort } : {}),
              },
            }
        }
      },
    }
  },

  validationRequiredWhen(config) {
    return !!config.apiKey?.trim()
  },
  validators: {
    ...createOpenAICompatibleValidators({
      checks: [ProviderValidationCheck.Connectivity, ProviderValidationCheck.ModelList, ProviderValidationCheck.ChatCompletions],
    }),
  },
})
