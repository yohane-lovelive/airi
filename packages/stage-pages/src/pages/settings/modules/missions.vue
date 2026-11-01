<script setup lang="ts">
import type { MissionInstance } from '@proj-airi/stage-ui/stores/missions'

import { useMissionsStore } from '@proj-airi/stage-ui/stores/missions'
import { FieldCheckbox, FieldRange, GhostButton } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()
const missions = useMissionsStore()
const { enabled, missedAgeLimitHours } = storeToRefs(missions)

const KEY = 'settings.pages.modules.missions'

const ended = computed(() => missions.missions.filter(mission => !missions.active.includes(mission)))

// The web app can show a reminder as a system notification only after the owner allows it. The owner turns missions on
// with a click, so the browser can ask at that moment. The desktop app needs no permission.
watch(enabled, (on) => {
  if (on && typeof Notification !== 'undefined' && Notification.permission === 'default')
    void Notification.requestPermission()
})

/** The name of a mission in the list: the reminder text, or the template for small talk. */
function nameOf(mission: MissionInstance) {
  return mission.template === 'reminder' ? mission.values.text : t(`${KEY}.small-talk.name`)
}

function repeatLabel(mission: MissionInstance) {
  if (mission.template === 'small-talk')
    return t(`${KEY}.small-talk.minutes`, { count: mission.values.minutes })
  const { repeat } = mission.values
  if (repeat.kind === 'interval') {
    return repeat.minutes % 60 === 0
      ? t(`${KEY}.repeat.interval-hours`, { count: repeat.minutes / 60 })
      : t(`${KEY}.repeat.interval-minutes`, { count: repeat.minutes })
  }
  if (repeat.kind !== 'weekly')
    return t(`${KEY}.repeat.${repeat.kind}`)
  // 2026-11-01 is a Sunday, so day N of the week is that date plus N days.
  const days = repeat.days.map(day => new Date(2026, 10, 1 + day).toLocaleDateString(locale.value, { weekday: 'short' })).join(', ')
  return t(`${KEY}.repeat.weekly`, { days })
}

function timeLabel(mission: MissionInstance) {
  if (mission.template === 'small-talk' && mission.status === 'running')
    return t(`${KEY}.small-talk.until`, { time: new Date(mission.values.endsAt).toLocaleTimeString(locale.value, { timeStyle: 'short' }) })
  if (mission.endReason && mission.template === 'small-talk')
    return `${t(`${KEY}.status.${mission.status}`)} · ${t(`${KEY}.end-reason.${mission.endReason}`)}`
  if (mission.nextRunAt === undefined)
    return t(`${KEY}.status.${mission.status}`)
  return t(`${KEY}.next`, { time: new Date(mission.nextRunAt).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' }) })
}
</script>

<template>
  <div :class="['flex flex-col', 'gap-4']">
    <div :class="['flex flex-col', 'gap-4', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <FieldCheckbox v-model="enabled" :label="t(`${KEY}.enable`)" :description="t(`${KEY}.enable-description`)" />
      <FieldRange
        v-model="missedAgeLimitHours"
        :label="t(`${KEY}.missed-age-limit`)"
        :description="t(`${KEY}.missed-age-limit-description`)"
        :min="1"
        :max="168"
        :step="1"
        :format-value="value => t(`${KEY}.hours`, { count: value })"
      />
    </div>

    <section :class="['flex flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-50 dark:bg-neutral-800/60', 'p-4']">
      <h2 :class="['flex items-center', 'gap-2', 'text-sm font-medium']">
        <span :class="['i-solar:alarm-bold-duotone', 'text-lg', 'text-primary-500 dark:text-primary-400']" aria-hidden="true" />
        <span :class="['min-w-0 flex-1']">{{ t(`${KEY}.active`) }}</span>
        <span :class="['text-xs', 'text-neutral-400 dark:text-neutral-500']">{{ missions.active.length }}</span>
      </h2>
      <ul v-if="missions.active.length" :class="['flex flex-col', 'gap-2']">
        <li
          v-for="mission in missions.active"
          :key="mission.id"
          :class="['flex items-start', 'gap-3', 'rounded-lg', 'bg-white dark:bg-neutral-900/60', 'px-3 py-2.5']"
        >
          <div :class="['min-w-0 flex-1', 'flex flex-col', 'gap-0.5']">
            <span :class="['text-sm font-medium', 'break-words']">{{ nameOf(mission) }}</span>
            <span :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">{{ timeLabel(mission) }} · {{ repeatLabel(mission) }}</span>
          </div>
          <GhostButton
            size="sm"
            icon="i-solar:stop-circle-linear"
            :aria-label="t(`${KEY}.stop`, { name: nameOf(mission) })"
            :title="t(`${KEY}.stop`, { name: nameOf(mission) })"
            @click="missions.stop(mission.id)"
          />
        </li>
      </ul>
      <p v-else :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.empty`) }}
      </p>
    </section>

    <section v-if="ended.length" :class="['flex flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-50 dark:bg-neutral-800/60', 'p-4']">
      <h2 :class="['flex items-center', 'gap-2', 'text-sm font-medium']">
        <span :class="['i-solar:history-bold-duotone', 'text-lg', 'text-neutral-400']" aria-hidden="true" />
        <span :class="['min-w-0 flex-1']">{{ t(`${KEY}.ended`) }}</span>
        <GhostButton size="sm" icon="i-solar:trash-bin-minimalistic-linear" @click="missions.removeEnded()">
          {{ t(`${KEY}.clear-ended`) }}
        </GhostButton>
      </h2>
      <ul :class="['flex flex-col', 'gap-2']">
        <li
          v-for="mission in ended"
          :key="mission.id"
          :class="['flex flex-col', 'gap-0.5', 'rounded-lg', 'bg-white dark:bg-neutral-900/60', 'px-3 py-2.5']"
        >
          <span :class="['text-sm', 'break-words', 'text-neutral-600 dark:text-neutral-300']">{{ nameOf(mission) }}</span>
          <span :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">{{ timeLabel(mission) }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.missions.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
