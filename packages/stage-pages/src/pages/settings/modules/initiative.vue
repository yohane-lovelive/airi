<script setup lang="ts">
import { INITIATIVE_LIMITS, useInitiativeStore } from '@proj-airi/stage-ui/stores/initiative'
import { FieldCheckbox, FieldInput, FieldRange } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const initiative = useInitiativeStore()
const { enabled, idleIntervalMinutes, dailyTurnBudget, quietHoursEnabled, quietHoursStart, quietHoursEnd } = storeToRefs(initiative)

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
