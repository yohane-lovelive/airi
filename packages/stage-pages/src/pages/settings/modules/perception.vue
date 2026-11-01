<script setup lang="ts">
import { FRAME_POLICY_NAMES } from '@proj-airi/stage-shared/perception'
import { IMAGE_BUDGET_LIMITS } from '@proj-airi/stage-ui/libs/perception/image-budget'
import { usePerceptionStore } from '@proj-airi/stage-ui/stores/perception'
import { usePerceptionRunnerStore } from '@proj-airi/stage-ui/stores/perception-runner'
import { usePerceptionStatusStore } from '@proj-airi/stage-ui/stores/perception-status'
import { Alert, Button, FieldCheckbox, FieldRange, FieldSelect, FieldTextArea } from '@proj-airi/ui'
import { useNow } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const perception = usePerceptionStore()
const { enabled, paused, exclusions, imagesPerHour, commentaryImagesPerHour, framePolicy, supported } = storeToRefs(perception)
const { status } = storeToRefs(usePerceptionStatusStore())
const runner = usePerceptionRunnerStore()

const KEY = 'settings.pages.modules.perception'

/** One entry on each line. Empty lines do not count. */
const exclusionText = computed({
  get: () => exclusions.value.join('\n'),
  set: (text: string) => {
    exclusions.value = text.split('\n').map(line => line.trim()).filter(Boolean)
  },
})

const framePolicyOptions = computed(() => FRAME_POLICY_NAMES.map(value => ({ value, label: t(`${KEY}.frame-policies.${value}`) })))

const canStart = computed(() => ['needs-share', 'ended', 'failed'].includes(status.value.state))
const megabytes = computed(() => (status.value.bytes / 1_000_000).toFixed(1))
const now = useNow({ interval: 10_000 })
const budget = computed(() => perception.budgetAt(now.value.getTime()))
</script>

<template>
  <div :class="['flex flex-col', 'gap-4']">
    <Alert v-if="!supported" tone="warning" :title="t(`${KEY}.unsupported`)" />

    <div :class="['flex flex-col', 'gap-4', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <FieldCheckbox v-model="enabled" :label="t(`${KEY}.enable`)" :description="t(`${KEY}.enable-description`)" />
      <FieldCheckbox v-if="enabled" v-model="paused" :label="t(`${KEY}.paused`)" :description="t(`${KEY}.paused-description`)" />
      <FieldRange
        v-model="imagesPerHour"
        :label="t(`${KEY}.images-per-hour`)"
        :description="t(`${KEY}.images-per-hour-description`)"
        :min="IMAGE_BUDGET_LIMITS.minImagesPerHour"
        :max="IMAGE_BUDGET_LIMITS.maxImagesPerHour"
        :step="1"
      />
      <FieldRange
        v-model="commentaryImagesPerHour"
        :label="t(`${KEY}.commentary-images-per-hour`)"
        :description="t(`${KEY}.commentary-images-per-hour-description`)"
        :min="IMAGE_BUDGET_LIMITS.minImagesPerHour"
        :max="IMAGE_BUDGET_LIMITS.maxImagesPerHour"
        :step="1"
      />
      <p :class="['text-xs', 'text-neutral-500 dark:text-neutral-400', 'tabular-nums']">
        {{ t(`${KEY}.images-sent`, { used: budget.used, limit: budget.limit }) }}
      </p>
    </div>

    <section v-if="enabled" :class="['flex flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-50 dark:bg-neutral-800/60', 'p-4']">
      <h2 :class="['flex items-center', 'gap-2', 'text-sm font-medium']">
        <span :class="['i-solar:eye-bold-duotone', 'text-lg', 'text-primary-500 dark:text-primary-400']" aria-hidden="true" />
        <span :class="['min-w-0 flex-1']">{{ t(`${KEY}.states.${status.state}`) }}</span>
        <Button v-if="canStart" size="sm" @click="runner.startFromGesture()">
          {{ t(`${KEY}.start`) }}
        </Button>
      </h2>
      <ul :class="['flex flex-col', 'gap-1', 'text-xs', 'text-neutral-500 dark:text-neutral-400', 'tabular-nums']">
        <li>{{ t(`${KEY}.frames`, { count: status.frames, size: megabytes }) }}</li>
        <li v-if="status.knowsForeground">
          {{ t(`${KEY}.foreground`, { app: status.foregroundApp ?? '-' }) }}{{ status.excludedNow ? ` · ${t(`${KEY}.excluded-now`)}` : '' }}
        </li>
        <li v-if="status.knowsForeground">
          {{ t(`${KEY}.excluded`, { count: status.excluded }) }}
        </li>
        <li v-if="status.error">
          {{ status.error }}
        </li>
      </ul>
    </section>

    <div :class="['flex flex-col', 'gap-4', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <FieldTextArea
        v-model="exclusionText"
        :label="t(`${KEY}.exclusions`)"
        :description="t(`${KEY}.exclusions-description`)"
        :required="false"
        :rows="8"
      />
      <Alert v-if="enabled && supported && !status.knowsForeground" tone="info" :title="t(`${KEY}.web-share`)" />
    </div>

    <div :class="['flex flex-col', 'gap-4', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <FieldSelect
        v-model="framePolicy"
        :label="t(`${KEY}.frame-policy`)"
        :description="t(`${KEY}.frame-policy-description`)"
        :options="framePolicyOptions"
      />
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.perception.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
