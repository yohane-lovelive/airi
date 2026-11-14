<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { FieldCheckbox, FieldCombobox } from '@proj-airi/ui'
import { computedAsync } from '@vueuse/core'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { z } from 'zod'

import { useProviderConfigStore } from '../../../stores/providers/config'
import { useProviderStore } from '../../../stores/providers/provider'

const props = defineProps<{ providerId: string }>()
const { t } = useI18n()
const store = useProviderConfigStore()
const providers = useProviderStore()
const schemaError = ref<string>()

// Catalog schemas own defaults and endpoint-specific availability. Read a snapshot
// before awaiting, so editing a field reloads its metadata without writing defaults.
const request = computed(() => ({
  definition: providers.getProviderDefinition(props.providerId),
  config: { ...store.getProviderConfig(props.providerId) },
}))
const schema = computedAsync<Record<string, z.ZodType> | undefined>(async (onCancel) => {
  const { definition, config } = request.value
  const controller = new AbortController()
  onCancel(() => controller.abort())
  schemaError.value = undefined
  try {
    const result = await definition.createProviderConfig({ t, config, abortSignal: controller.signal })
    return result instanceof z.ZodObject ? result.shape : undefined
  }
  catch (error) {
    if (!controller.signal.aborted)
      schemaError.value = errorMessageFrom(error) ?? t('settings.pages.providers.catalog.edit.config.load-error')
    return undefined
  }
})

const protocolField = computed(() => schema.value?.api)
const searchField = computed(() => schema.value?.webSearch)
// Only some providers define how a server reads a reasoning level, for example OpenAI-compatible servers.
const reasoningField = computed(() => schema.value?.reasoningControl)

/** The string options in the metadata of a select field. */
function optionsOf(field: z.ZodType | undefined) {
  const options: { label: string, value: string }[] = []
  const metadata = field?.meta()
  if (Array.isArray(metadata?.options)) {
    for (const option of metadata.options as unknown[]) {
      if (option && typeof option === 'object' && 'label' in option && 'value' in option && typeof option.label === 'string' && typeof option.value === 'string')
        options.push({ label: option.label, value: option.value })
    }
  }
  return options
}

/** The text of a field in its metadata, for a field whose label comes from its provider. */
function textOf(field: z.ZodType | undefined, key: 'labelLocalized' | 'descriptionLocalized') {
  const value = field?.meta()?.[key]
  return typeof value === 'string' ? value : ''
}

/** The saved value of a string field, or its default when nothing is saved. */
function stringValueOf(field: z.ZodType | undefined, key: string) {
  const parsed = field?.safeParse(store.getProviderConfig(props.providerId)?.[key])
  return parsed?.success && typeof parsed.data === 'string' ? parsed.data : ''
}

const protocolOptions = computed(() => optionsOf(protocolField.value))
const protocol = computed(() => stringValueOf(protocolField.value, 'api'))
const reasoningOptions = computed(() => optionsOf(reasoningField.value))
const reasoningControl = computed(() => stringValueOf(reasoningField.value, 'reasoningControl'))
const webSearch = computed(() => {
  const parsed = searchField.value?.safeParse(store.getProviderConfig(props.providerId)?.webSearch)
  return parsed?.success === true && parsed.data === true
})

/**
 * Triggering workflow:
 * Combobox/Checkbox `update:modelValue` -> {@link setField} -> {@link store.patchProviderConfig}.
 */
async function setField(...[key, value]: ['api' | 'reasoningControl', string | undefined] | ['webSearch', boolean]) {
  // Clearing the combobox does not select an option. Keep the current choice.
  if (value === undefined)
    return
  // Apply only the changed field on the leader. The action ignores a provider
  // removed by another window before this event arrives.
  await store.patchProviderConfig(props.providerId, { [key]: value })
}
</script>

<template>
  <p v-if="schemaError" role="alert">
    {{ schemaError }}
  </p>
  <FieldCombobox
    v-if="protocolField"
    layout="vertical"
    :model-value="protocol"
    :options="protocolOptions"
    :label="t('settings.pages.providers.catalog.edit.config.common.fields.field.api-protocol.label')"
    :description="t('settings.pages.providers.catalog.edit.config.common.fields.field.api-protocol.description')"
    @update:model-value="setField('api', $event)"
  />
  <FieldCombobox
    v-if="reasoningField"
    layout="vertical"
    :model-value="reasoningControl"
    :options="reasoningOptions"
    :label="textOf(reasoningField, 'labelLocalized')"
    :description="textOf(reasoningField, 'descriptionLocalized')"
    @update:model-value="setField('reasoningControl', $event)"
  />
  <FieldCheckbox
    v-if="searchField"
    :model-value="webSearch"
    :disabled="searchField.meta()?.disabled === true"
    :label="t('settings.pages.providers.catalog.edit.config.common.fields.field.web-search.label')"
    :description="t('settings.pages.providers.catalog.edit.config.common.fields.field.web-search.description')"
    @update:model-value="setField('webSearch', $event)"
  />
</template>
