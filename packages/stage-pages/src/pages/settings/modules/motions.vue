<script setup lang="ts">
import type { MotionEntry } from '@proj-airi/stage-ui/stores/motion-library'

import { errorMessageFrom } from '@moeru/std'
import { useMotionLibraryStore } from '@proj-airi/stage-ui/stores/motion-library'
import { Button, FieldCheckbox, FieldInput, FieldInputFile, GhostButton } from '@proj-airi/ui'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const library = useMotionLibraryStore()

const KEY = 'settings.pages.modules.motions'

const files = ref<File[]>()
const description = ref('')
const tags = ref('')
const importing = ref(false)
const importError = ref<string>()

const canImport = computed(() => !!files.value?.length && description.value.trim().length > 0 && !importing.value)

function metaOf(entry: MotionEntry) {
  return [
    t(`${KEY}.source.${entry.source}`),
    t(`${KEY}.seconds`, { count: Math.round(entry.duration * 10) / 10 }),
    t(`${KEY}.uses`, { count: entry.useCount }),
  ].join(' · ')
}

async function importFile() {
  const file = files.value?.[0]
  if (!file)
    return
  importing.value = true
  importError.value = undefined
  try {
    const entry = await library.importVrma(
      { name: file.name, vrma: await file.arrayBuffer() },
      { description: description.value.trim(), tags: tags.value.split(/[,、，]/).map(tag => tag.trim()).filter(Boolean) },
    )
    if (!entry) {
      importError.value = t(`${KEY}.import.no-animation`)
      return
    }
    files.value = undefined
    description.value = ''
    tags.value = ''
  }
  catch (error) {
    importError.value = errorMessageFrom(error) ?? t(`${KEY}.import.no-animation`)
  }
  finally {
    importing.value = false
  }
}
</script>

<template>
  <div :class="['flex flex-col', 'gap-4']">
    <p :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
      {{ t(`${KEY}.intro`) }}
    </p>

    <section :class="['flex flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-50 dark:bg-neutral-800/60', 'p-4']">
      <h2 :class="['flex items-center', 'gap-2', 'text-sm font-medium']">
        <span :class="['i-solar:running-round-bold-duotone', 'text-lg', 'text-primary-500 dark:text-primary-400']" aria-hidden="true" />
        <span :class="['min-w-0 flex-1']">{{ t(`${KEY}.clips`) }}</span>
        <span :class="['text-xs', 'text-neutral-400 dark:text-neutral-500']">{{ library.entries.length }}</span>
      </h2>
      <p :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.preview-note`) }}
      </p>
      <ul :class="['flex flex-col', 'gap-2']">
        <li
          v-for="entry in library.entries"
          :key="entry.id"
          :class="['flex items-start', 'gap-3', 'rounded-lg', 'bg-white dark:bg-neutral-900/60', 'px-3 py-2.5']"
        >
          <div :class="['min-w-0 flex-1', 'flex flex-col', 'gap-1']">
            <FieldCheckbox
              :model-value="entry.enabled"
              :label="entry.name"
              :description="entry.description"
              @update:model-value="value => library.setEnabled(entry.id, value)"
            />
            <span :class="['text-xs', 'text-neutral-500 dark:text-neutral-400', 'break-words']">{{ metaOf(entry) }}</span>
            <span v-if="entry.tags.length" :class="['text-xs', 'text-neutral-400 dark:text-neutral-500', 'break-words']">{{ entry.tags.join(', ') }}</span>
          </div>
          <GhostButton
            size="sm"
            icon="i-solar:play-circle-linear"
            :aria-label="t(`${KEY}.preview`, { name: entry.name })"
            :title="t(`${KEY}.preview`, { name: entry.name })"
            @click="library.requestPreview(entry.id)"
          />
          <GhostButton
            v-if="entry.source === 'imported'"
            size="sm"
            icon="i-solar:trash-bin-minimalistic-linear"
            :aria-label="t(`${KEY}.remove`, { name: entry.name })"
            :title="t(`${KEY}.remove`, { name: entry.name })"
            @click="library.remove(entry.id)"
          />
        </li>
      </ul>
    </section>

    <section :class="['flex flex-col', 'gap-3', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <h2 :class="['flex items-center', 'gap-2', 'text-sm font-medium']">
        <span :class="['i-solar:upload-bold-duotone', 'text-lg', 'text-primary-500 dark:text-primary-400']" aria-hidden="true" />
        <span>{{ t(`${KEY}.import.title`) }}</span>
      </h2>
      <FieldInputFile v-model="files" accept=".vrma" :label="t(`${KEY}.import.file`)" :description="t(`${KEY}.import.file-description`)" />
      <FieldInput v-model="description" :label="t(`${KEY}.import.description`)" :description="t(`${KEY}.import.description-hint`)" />
      <FieldInput v-model="tags" :label="t(`${KEY}.import.tags`)" :description="t(`${KEY}.import.tags-hint`)" />
      <p v-if="importError" :class="['text-xs', 'text-red-600 dark:text-red-400']">
        {{ importError }}
      </p>
      <div>
        <Button :disabled="!canImport" @click="importFile">
          {{ t(`${KEY}.import.submit`) }}
        </Button>
      </div>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.motions.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
