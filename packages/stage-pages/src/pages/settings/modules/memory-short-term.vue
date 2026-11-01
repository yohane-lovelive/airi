<script setup lang="ts">
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useHistorySummaryStore } from '@proj-airi/stage-ui/stores/history-summary'
import { FieldCheckbox, GhostButton } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()
const { enabled } = storeToRefs(useHistorySummaryStore())
const chatSession = useChatSessionStore()
const { activeSessionId, sessionMetas } = storeToRefs(chatSession)

const KEY = 'settings.pages.modules.memory-short-term'

const summary = computed(() => sessionMetas.value[activeSessionId.value]?.historySummary)
</script>

<template>
  <div :class="['flex flex-col', 'gap-4']">
    <div :class="['flex flex-col', 'gap-4', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <FieldCheckbox v-model="enabled" :label="t(`${KEY}.summary`)" :description="t(`${KEY}.summary-description`)" />
    </div>

    <section :class="['flex flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-50 dark:bg-neutral-800/60', 'p-4']">
      <h2 :class="['flex items-center', 'gap-2', 'text-sm font-medium']">
        <span :class="['i-solar:notes-bold-duotone', 'text-lg', 'text-primary-500 dark:text-primary-400']" aria-hidden="true" />
        <span :class="['min-w-0 flex-1']">{{ t(`${KEY}.current`) }}</span>
        <GhostButton v-if="summary" size="sm" icon="i-solar:trash-bin-minimalistic-linear" @click="chatSession.setSessionHistorySummary(activeSessionId, undefined)">
          {{ t(`${KEY}.remove`) }}
        </GhostButton>
      </h2>
      <template v-if="summary">
        <p :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
          {{ t(`${KEY}.covered`, { count: summary.coveredCount, time: new Date(summary.createdAt).toLocaleString(locale) }) }}
        </p>
        <p :class="['whitespace-pre-wrap', 'rounded-lg', 'bg-white dark:bg-neutral-900/60', 'px-3 py-2.5', 'text-sm']">
          {{ summary.text }}
        </p>
      </template>
      <p v-else :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.empty`) }}
      </p>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory-short-term.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
