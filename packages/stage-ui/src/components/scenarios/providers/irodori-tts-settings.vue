<script setup lang="ts">
import type { SpeechProvider } from '@xsai-ext/providers/utils'

import { Alert, Button, FieldRange, FieldTextArea } from '@proj-airi/ui'
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import IrodoriReferenceVoices from './irodori-reference-voices.vue'
import SpeechPlayground from './speech-playground.vue'
import SpeechProviderSettings from './speech-provider-settings.vue'

import { useProviderValidation } from '../../../composables/use-provider-validation'
import { useSpeechStore } from '../../../stores/modules/speech'
import { useProviderConfigStore } from '../../../stores/providers/config'
import { useProviderStore } from '../../../stores/providers/provider'

const props = defineProps<{
  providerId: string
  defaultText: string
}>()

const { t } = useI18n()
const speechStore = useSpeechStore()
const providersStore = useProviderStore()
const providerStore = useProviderConfigStore()

// The server takes a key only when `IRODORI_API_KEY` is set. An empty key sends no header.
const apiKeyConfigured = true

const availableVoices = computed(() => speechStore.availableVoices[props.providerId] || [])

// The server takes no key by default, so the stored configuration can equal the
// schema defaults, and the store validation sweep skips the provider. This call
// marks the provider `configured`, as for the VOICEVOX family.
const { forceValid, isValid, isValidating, validationMessage } = useProviderValidation(props.providerId)

// SpeechProviderSettings loads the voices on mount only for a `configured`
// provider. The validation above resolves after that mount.
watch(() => providerStore.configuredProviders[props.providerId], async (configured) => {
  if (configured)
    await speechStore.loadVoicesForProvider(props.providerId)
})

async function handleGenerateSpeech(input: string, voiceId: string) {
  const provider = await providersStore.getProviderInstance(props.providerId) as SpeechProvider
  if (!provider)
    throw new Error('Failed to initialize speech provider')

  return await speechStore.speech(
    provider,
    'irodori-tts',
    input,
    voiceId,
    { ...providerStore.getProviderConfig(props.providerId) },
  )
}
</script>

<template>
  <SpeechProviderSettings :provider-id="props.providerId" default-model="irodori-tts" placeholder="IRODORI_API_KEY">
    <template #basic-settings>
      <Alert v-if="isValidating > 0" tone="info" loading :title="t('settings.dialogs.onboarding.validationRunning')" />
      <Alert v-else-if="!isValid && validationMessage" tone="danger" :title="t('settings.dialogs.onboarding.validationFailed')">
        <div :class="['whitespace-pre-wrap break-all']">
          {{ validationMessage }}
        </div>
        <template #actions>
          <Button size="sm" color="red" @click="forceValid">
            {{ t('settings.pages.providers.common.continueAnyway') }}
          </Button>
        </template>
      </Alert>
      <Alert v-else-if="isValid" tone="success" :title="t('settings.dialogs.onboarding.validationSuccess')" />
    </template>

    <template #voice-settings="{ voiceSettings }">
      <div :class="['flex flex-col gap-6']">
        <IrodoriReferenceVoices :provider-id="props.providerId" />

        <FieldTextArea
          v-model="voiceSettings.caption"
          :label="t('settings.pages.providers.provider.irodori-tts.fields.field.caption.label')"
          :description="t('settings.pages.providers.provider.irodori-tts.fields.field.caption.description')"
          :placeholder="t('settings.pages.providers.provider.irodori-tts.fields.field.caption.placeholder')"
          :required="false"
          :rows="3"
        />

        <FieldRange
          v-model="voiceSettings.numSteps"
          :label="t('settings.pages.providers.provider.irodori-tts.fields.field.num-steps.label')"
          :description="t('settings.pages.providers.provider.irodori-tts.fields.field.num-steps.description')"
          :min="0" :max="64" :step="1"
        />

        <FieldRange
          v-model="voiceSettings.speed"
          :label="t('settings.pages.providers.provider.common.fields.field.speed.label')"
          :description="t('settings.pages.providers.provider.common.fields.field.speed.description')"
          :min="0.5" :max="2" :step="0.01"
        />
      </div>
    </template>

    <template #playground>
      <SpeechPlayground
        :available-voices="availableVoices"
        :generate-speech="handleGenerateSpeech"
        :api-key-configured="apiKeyConfigured"
        :use-ssml="false"
        :default-text="props.defaultText"
      />
    </template>
  </SpeechProviderSettings>
</template>
