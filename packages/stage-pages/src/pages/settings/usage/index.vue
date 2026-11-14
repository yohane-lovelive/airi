<script setup lang="ts">
import { firstKeptUsageDay, usageByPurpose, usageDayOf, useUsageStore } from '@proj-airi/stage-ui/stores/usage'
import { useNow } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()
const { records } = storeToRefs(useUsageStore())

const KEY = 'settings.pages.usage'

// The day changes at midnight, so the views read the clock again each minute.
const now = useNow({ interval: 60_000 })
const periods = computed(() => [
  { id: 'today', fromDay: usageDayOf(now.value.getTime()) },
  { id: 'last-30-days', fromDay: firstKeptUsageDay(now.value.getTime()) },
].map((period) => {
  const purposes = usageByPurpose(records.value, period.fromDay)
  const totalTokens = purposes.reduce((sum, purpose) => sum + purpose.totalTokens, 0)
  return { ...period, purposes, totalTokens }
}))

function count(value: number) {
  return value.toLocaleString(locale.value)
}

/** The share of the tokens of a period, for the bar. */
function share(tokens: number, total: number) {
  return total > 0 ? `${Math.round(tokens / total * 100)}%` : '0%'
}
</script>

<template>
  <div :class="['flex flex-col', 'gap-4']">
    <p :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
      {{ t(`${KEY}.intro`) }}
    </p>

    <section
      v-for="period in periods"
      :key="period.id"
      :class="['flex flex-col', 'gap-3', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']"
    >
      <h2 :class="['flex items-baseline', 'gap-2', 'text-sm font-medium']">
        <span :class="['min-w-0 flex-1']">{{ t(`${KEY}.periods.${period.id}`) }}</span>
        <span :class="['text-xs font-normal', 'text-neutral-500 dark:text-neutral-400']">
          {{ t(`${KEY}.tokens`, { count: count(period.totalTokens) }) }}
        </span>
      </h2>
      <ul v-if="period.purposes.length" :class="['flex flex-col', 'gap-2']">
        <li
          v-for="purpose in period.purposes"
          :key="purpose.purpose"
          :class="['flex flex-col', 'gap-1.5', 'rounded-lg', 'bg-white dark:bg-neutral-800/60', 'px-3 py-2.5']"
        >
          <div :class="['flex items-baseline', 'gap-2', 'text-sm']">
            <span :class="['min-w-0 flex-1', 'truncate']">{{ t(`${KEY}.purposes.${purpose.purpose}`) }}</span>
            <span :class="['font-medium', 'tabular-nums']">{{ count(purpose.totalTokens) }}</span>
          </div>
          <div :class="['h-1.5', 'overflow-hidden', 'rounded-full', 'bg-neutral-200 dark:bg-neutral-700']">
            <div
              :class="['h-full', 'rounded-full', 'bg-primary-500 dark:bg-primary-400']"
              :style="{ width: share(purpose.totalTokens, period.totalTokens) }"
            />
          </div>
          <p :class="['text-xs', 'text-neutral-500 dark:text-neutral-400', 'tabular-nums']">
            {{ t(`${KEY}.details`, { input: count(purpose.inputTokens), output: count(purpose.outputTokens), calls: count(purpose.calls), images: count(purpose.images) }) }}
            <template v-if="purpose.unreportedCalls">
              · {{ t(`${KEY}.unreported`, { count: count(purpose.unreportedCalls) }) }}
            </template>
          </p>
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
  titleKey: settings.pages.usage.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.usage.description
  icon: i-solar:chart-2-bold-duotone
  settingsEntry: true
  order: 9
  stageTransition:
    name: slide
</route>
