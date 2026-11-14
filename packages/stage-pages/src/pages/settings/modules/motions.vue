<script setup lang="ts">
import type { MotionGeneratorSettingsUpdate, MotionGeneratorStatus } from '@proj-airi/stage-ui/stores/motion-generation'
import type { MotionEntry } from '@proj-airi/stage-ui/stores/motion-library'

import { errorMessageFrom } from '@moeru/std'
import { useMotionGenerationStore } from '@proj-airi/stage-ui/stores/motion-generation'
import { useMotionLibraryStore } from '@proj-airi/stage-ui/stores/motion-library'
import { Button, FieldCheckbox, FieldInput, FieldInputFile, FieldRange, GhostButton } from '@proj-airi/ui'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const library = useMotionLibraryStore()
const generation = useMotionGenerationStore()

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
    ...(entry.kept ? [] : [t(`${KEY}.not-kept`)]),
    t(`${KEY}.seconds`, { count: Math.round(entry.duration * 10) / 10 }),
    t(`${KEY}.uses`, { count: entry.useCount }),
  ].join(' · ')
}

// The desktop app owns the generator and its settings. The page reads them through the connection.
const generator = ref<MotionGeneratorStatus>()
const generatorUrl = ref('')
const generatorToken = ref('')
const generatorBusy = ref(false)
const generatorMessage = ref<{ ok: boolean, text: string }>()

function showGenerator(status: MotionGeneratorStatus) {
  generator.value = status
  generatorUrl.value = status.baseUrl
}

async function runGenerator(action: () => Promise<void>) {
  generatorBusy.value = true
  generatorMessage.value = undefined
  try {
    await action()
  }
  catch (error) {
    generatorMessage.value = { ok: false, text: errorMessageFrom(error) ?? t(`${KEY}.generator.failed`) }
  }
  finally {
    generatorBusy.value = false
  }
}

function updateGenerator(update: MotionGeneratorSettingsUpdate) {
  const connection = generation.connection
  if (connection)
    return runGenerator(async () => showGenerator(await connection.setConfig(update)))
}

/** An empty token field keeps the stored token, so the owner can change the port without the token. */
function saveGenerator() {
  const token = generatorToken.value.trim()
  return updateGenerator({ baseUrl: generatorUrl.value, ...(token ? { token } : {}) })?.then(() => {
    generatorToken.value = ''
  })
}

function checkGenerator() {
  const connection = generation.connection
  if (connection) {
    return runGenerator(async () => {
      await connection.check()
      generatorMessage.value = { ok: true, text: t(`${KEY}.generator.check-ok`) }
    })
  }
}

onMounted(() => {
  const connection = generation.connection
  if (connection)
    void runGenerator(async () => showGenerator(await connection.getConfig()))
})

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
            v-if="!entry.kept"
            size="sm"
            icon="i-solar:check-circle-linear"
            :aria-label="t(`${KEY}.keep`, { name: entry.name })"
            :title="t(`${KEY}.keep`, { name: entry.name })"
            @click="library.keep(entry.id)"
          />
          <GhostButton
            v-if="entry.source !== 'built-in'"
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

    <section :class="['flex flex-col', 'gap-3', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <h2 :class="['flex items-center', 'gap-2', 'text-sm font-medium']">
        <span :class="['i-solar:magic-stick-3-bold-duotone', 'text-lg', 'text-primary-500 dark:text-primary-400']" aria-hidden="true" />
        <span>{{ t(`${KEY}.generator.title`) }}</span>
      </h2>
      <p :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.generator.intro`) }}
      </p>
      <p v-if="!generation.connection" :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.generator.desktop-only`) }}
      </p>
      <template v-else-if="generator">
        <FieldCheckbox
          :model-value="generator.enabled"
          :label="t(`${KEY}.generator.enable`)"
          :description="t(`${KEY}.generator.enable-description`)"
          @update:model-value="value => updateGenerator({ enabled: value })"
        />
        <FieldInput
          v-model="generatorUrl"
          :label="t(`${KEY}.generator.address`)"
          :description="t(`${KEY}.generator.address-description`)"
          :disabled="generatorBusy"
          autocomplete="off"
        />
        <FieldInput
          v-model="generatorToken"
          type="password"
          :label="t(`${KEY}.generator.token`)"
          :description="generator.hasToken ? t(`${KEY}.generator.token-saved`) : t(`${KEY}.generator.token-description`)"
          :placeholder="generator.hasToken ? generator.tokenPreview : ''"
          :disabled="generatorBusy"
          autocomplete="off"
        />
        <div :class="['flex flex-row flex-wrap items-center', 'gap-3']">
          <Button :disabled="generatorBusy" @click="saveGenerator">
            {{ t(`${KEY}.generator.save`) }}
          </Button>
          <Button :disabled="generatorBusy || !generator.hasToken" variant="secondary" @click="checkGenerator">
            {{ t(`${KEY}.generator.check`) }}
          </Button>
        </div>
        <p v-if="generatorMessage" :class="['text-xs', generatorMessage.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400']">
          {{ generatorMessage.text }}
        </p>
        <FieldRange
          :model-value="generator.dailyLimit"
          as="div"
          :min="1"
          :max="20"
          :step="1"
          :label="t(`${KEY}.generator.daily-limit`)"
          :description="t(`${KEY}.generator.daily-limit-description`)"
          @update:model-value="value => updateGenerator({ dailyLimit: value })"
        />
        <p :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
          {{ t(`${KEY}.generator.used-today`, { count: generator.usedToday, limit: generator.dailyLimit }) }}
        </p>
        <p v-if="generator.lastError" :class="['text-xs', 'text-red-600 dark:text-red-400', 'break-words']">
          {{ t(`${KEY}.generator.last-error`, { message: generator.lastError }) }}
        </p>
      </template>
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
