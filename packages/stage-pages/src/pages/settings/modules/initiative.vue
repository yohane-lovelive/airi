<script setup lang="ts">
import { useTalkChanges } from '@proj-airi/stage-ui/composables/use-talk-changes'
import { INITIATIVE_LIMITS, useInitiativeStore } from '@proj-airi/stage-ui/stores/initiative'
import { FieldCheckbox, FieldInput, FieldRange, GhostButton } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const { enabled, idleIntervalMinutes, dailyTurnBudget, quietHoursEnabled, quietHoursStart, quietHoursEnd } = storeToRefs(useInitiativeStore())
const { changes: talkChanges, reset: resetTalkChanges } = useTalkChanges()

const KEY = 'settings.pages.modules.initiative'
</script>

<template>
  <div :class="['flex flex-col', 'gap-4']">
    <div :class="['flex flex-col', 'gap-4', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <FieldCheckbox v-model="enabled" :label="t(`${KEY}.enable`)" :description="t(`${KEY}.enable-description`)" />
      <FieldRange
        v-model="idleIntervalMinutes"
        :label="t(`${KEY}.idle-interval`)"
        :description="t(`${KEY}.idle-interval-description`)"
        :min="INITIATIVE_LIMITS.minIdleIntervalMinutes"
        :max="INITIATIVE_LIMITS.maxIdleIntervalMinutes"
        :step="1"
        :format-value="value => t(`${KEY}.minutes`, { count: value })"
      />
      <FieldRange
        v-model="dailyTurnBudget"
        :label="t(`${KEY}.daily-turn-budget`)"
        :description="t(`${KEY}.daily-turn-budget-description`)"
        :min="INITIATIVE_LIMITS.minDailyTurnBudget"
        :max="INITIATIVE_LIMITS.maxDailyTurnBudget"
        :step="1"
      />
    </div>

    <div :class="['flex flex-col', 'gap-4', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <FieldCheckbox v-model="quietHoursEnabled" :label="t(`${KEY}.quiet-hours`)" :description="t(`${KEY}.quiet-hours-description`)" />
      <div v-if="quietHoursEnabled" :class="['grid grid-cols-1 sm:grid-cols-2', 'gap-4']">
        <FieldInput v-model="quietHoursStart" type="time" :label="t(`${KEY}.quiet-hours-start`)" />
        <FieldInput v-model="quietHoursEnd" type="time" :label="t(`${KEY}.quiet-hours-end`)" />
      </div>
    </div>

    <section :class="['flex flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-50 dark:bg-neutral-800/60', 'p-4']">
      <h2 :class="['flex items-center', 'gap-2', 'text-sm font-medium']">
        <span :class="['i-solar:chat-round-line-bold-duotone', 'text-lg', 'text-primary-500 dark:text-primary-400']" aria-hidden="true" />
        <span :class="['min-w-0 flex-1']">{{ t(`${KEY}.talk-changes`) }}</span>
        <GhostButton v-if="talkChanges.length" size="sm" icon="i-solar:restart-linear" @click="resetTalkChanges()">
          {{ t(`${KEY}.reset-talk-changes`) }}
        </GhostButton>
      </h2>
      <p :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.talk-changes-description`) }}
      </p>
      <ul v-if="talkChanges.length" :class="['flex flex-col', 'gap-2']">
        <li
          v-for="change in talkChanges"
          :key="change"
          :class="['rounded-lg', 'bg-white dark:bg-neutral-900/60', 'px-3 py-2.5', 'text-sm']"
        >
          {{ change }}
        </li>
      </ul>
      <p v-else :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.talk-changes-empty`) }}
      </p>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.initiative.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
