<script setup lang="ts">
import type { RecordingInfo } from '@proj-airi/stage-ui/libs/perception/recorder'

import { errorMessageFrom } from '@moeru/std'
import { usePerceptionStore } from '@proj-airi/stage-ui/stores/perception'
import { usePerceptionRunnerStore } from '@proj-airi/stage-ui/stores/perception-runner'
import { usePerceptionStatusStore } from '@proj-airi/stage-ui/stores/perception-status'
import { Alert, Button, GhostButton } from '@proj-airi/ui'
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()
const { enabled } = storeToRefs(usePerceptionStore())
const statusStore = usePerceptionStatusStore()
const { status, recordingWanted } = storeToRefs(statusStore)
const recorder = usePerceptionRunnerStore().recorder()

const KEY = 'tamagotchi.settings.devtools.pages.perception-recorder'
const recordings = ref<RecordingInfo[]>([])
const error = ref('')

const running = computed(() => status.value.state === 'running')

async function refresh() {
  if (!recorder)
    return
  try {
    recordings.value = await recorder.list()
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? ''
  }
}

// The list reads the folder again now and then, so a running recording shows its frames.
useIntervalFn(() => void refresh(), 3_000, { immediateCallback: true })

async function remove(id: string) {
  await recorder?.remove(id)
  await refresh()
}

function timeLabel(at: number) {
  return new Date(at).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'medium' })
}

function minutesOf(recording: RecordingInfo) {
  return (((recording.endedAt ?? Date.now()) - recording.startedAt) / 60_000).toFixed(1)
}
</script>

<template>
  <div :class="['flex flex-col', 'gap-4', 'pb-12']">
    <p :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
      {{ t(`${KEY}.intro`) }}
    </p>

    <Alert v-if="!recorder" tone="warning" :title="t(`${KEY}.unsupported`)" />
    <Alert v-else-if="!enabled || !running" tone="info" :title="t(`${KEY}.needs-perception`)" />
    <Alert v-if="error" tone="danger" :title="error" />

    <section v-if="recorder" :class="['flex flex-col', 'gap-3', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <div :class="['flex flex-wrap items-center', 'gap-2']">
        <Button v-if="!recordingWanted" color="primary" variant="primary" :disabled="!running" @click="statusStore.requestRecording(true)">
          {{ t(`${KEY}.start`) }}
        </Button>
        <Button v-else color="red" variant="primary" @click="statusStore.requestRecording(false)">
          {{ t(`${KEY}.stop`) }}
        </Button>
        <GhostButton icon="i-solar:folder-open-linear" @click="recorder.openFolder()">
          {{ t(`${KEY}.open-folder`) }}
        </GhostButton>
      </div>
      <p v-if="status.recording" :class="['text-sm', 'tabular-nums']">
        <span :class="['i-solar:record-circle-bold', 'text-red-500', 'align-middle']" aria-hidden="true" />
        {{ t(`${KEY}.recording`, { count: status.recording.frames }) }}
      </p>
      <p :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.limits`) }}
      </p>
    </section>

    <section v-if="recorder" :class="['flex flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-50 dark:bg-neutral-800/60', 'p-4']">
      <h2 :class="['text-sm font-medium']">
        {{ t(`${KEY}.recordings`) }}
      </h2>
      <ul v-if="recordings.length" :class="['flex flex-col', 'gap-2']">
        <li
          v-for="recording in recordings"
          :key="recording.id"
          :class="['flex items-center', 'gap-3', 'rounded-lg', 'bg-white dark:bg-neutral-900/60', 'px-3 py-2.5']"
        >
          <div :class="['min-w-0 flex-1', 'flex flex-col', 'gap-0.5']">
            <span :class="['text-sm font-medium', 'break-words']">{{ timeLabel(recording.startedAt) }}</span>
            <span :class="['text-xs', 'text-neutral-500 dark:text-neutral-400', 'tabular-nums']">
              {{ t(`${KEY}.summary`, { frames: recording.frames, minutes: minutesOf(recording), size: (recording.bytes / 1_000_000).toFixed(1) }) }}{{ recording.recording ? ` · ${t(`${KEY}.now`)}` : '' }}
            </span>
          </div>
          <GhostButton
            size="sm"
            icon="i-solar:trash-bin-minimalistic-linear"
            :aria-label="t(`${KEY}.delete`)"
            :title="t(`${KEY}.delete`)"
            @click="remove(recording.id)"
          />
        </li>
      </ul>
      <p v-else :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.empty`) }}
      </p>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: tamagotchi.settings.devtools.pages.perception-recorder.title
  subtitleKey: tamagotchi.settings.devtools.title
</route>
