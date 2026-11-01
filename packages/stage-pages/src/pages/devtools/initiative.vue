<script setup lang="ts">
import { useTalkChanges } from '@proj-airi/stage-ui/composables/use-talk-changes'
import { useInitiativeStore } from '@proj-airi/stage-ui/stores/initiative'
import { INSPECTOR_WATCH_REFRESH_MS, useInitiativeInspectorStore } from '@proj-airi/stage-ui/stores/initiative-inspector'
import { useIntentionsStore } from '@proj-airi/stage-ui/stores/intentions'
import { useMissionsStore } from '@proj-airi/stage-ui/stores/missions'
import { usageByPurpose, usageDayOf, useUsageStore } from '@proj-airi/stage-ui/stores/usage'
import { GhostButton } from '@proj-airi/ui'
import { useIntervalFn, useNow } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()
const inspector = useInitiativeInspectorStore()
const { snapshot } = storeToRefs(inspector)
const { enabled } = storeToRefs(useInitiativeStore())
const intentions = useIntentionsStore()
const { active: activeMissions } = storeToRefs(useMissionsStore())
const { records: usageRecords } = storeToRefs(useUsageStore())
const { changes: talkChanges, reset: resetTalkChanges } = useTalkChanges()

const KEY = 'tamagotchi.settings.devtools.pages.initiative-inspector'
/** The graph shows this much time. */
const HISTORY_MS = 10 * 60_000
/** A readout older than this means that the leader stopped publishing. */
const STALE_AFTER_MS = 5_000

// The leader publishes only while a window watches, so the page marks itself while it is open.
useIntervalFn(() => inspector.markWatching(), INSPECTOR_WATCH_REFRESH_MS, { immediateCallback: true })

const now = useNow({ interval: 1_000 })
const readout = computed(() => snapshot.value && now.value.getTime() - snapshot.value.at < STALE_AFTER_MS ? snapshot.value.readout : undefined)
const rhythm = computed(() => readout.value ? snapshot.value?.rhythm : undefined)
const topics = computed(() => readout.value ? snapshot.value?.topics : undefined)

/** Drive and threshold samples of this page. Each page keeps its own history from the time it opened. */
const history = ref<Array<{ at: number, drive: number, threshold: number }>>([])
watch(() => snapshot.value?.at, (at) => {
  if (at === undefined || !snapshot.value)
    return
  const { drive, threshold } = snapshot.value.readout
  history.value = [...history.value.filter(sample => sample.at > at - HISTORY_MS), { at, drive: drive.total, threshold }]
})

const GRAPH = { width: 560, height: 120 }
const graph = computed(() => {
  const samples = history.value
  const end = samples.at(-1)?.at ?? now.value.getTime()
  const top = Math.max(1.2, ...samples.flatMap(sample => [sample.drive, sample.threshold])) * 1.1
  const point = (at: number, value: number) => `${((at - (end - HISTORY_MS)) / HISTORY_MS * GRAPH.width).toFixed(1)},${(GRAPH.height - value / top * GRAPH.height).toFixed(1)}`
  return {
    drive: samples.map(sample => point(sample.at, sample.drive)).join(' '),
    threshold: samples.map(sample => point(sample.at, sample.threshold)).join(' '),
    top,
  }
})

const status = computed(() => {
  if (!enabled.value)
    return t(`${KEY}.status.off`)
  if (!readout.value)
    return t(`${KEY}.status.waiting`)
  return t(`${KEY}.reasons.${readout.value.waitReason ?? 'ready'}`)
})

/** The drive, its parts, and the inner state. A threshold before the jitter draw has a mark. */
const stats = computed(() => {
  const value = readout.value
  if (!value)
    return []
  return [
    { label: t(`${KEY}.drive`), value: number(value.drive.total) },
    { label: t(`${KEY}.threshold`), value: `${number(value.threshold)}${value.jitterDrawn ? '' : ' *'}` },
    { label: t(`${KEY}.parts.pressure`), value: number(value.drive.pressure) },
    { label: t(`${KEY}.parts.boredom`), value: number(value.drive.boredom) },
    { label: t(`${KEY}.parts.intention`), value: number(value.drive.intention) },
    { label: t(`${KEY}.inner.energy`), value: number(value.inner.energy) },
    { label: t(`${KEY}.inner.mood`), value: number(value.inner.mood) },
    { label: t(`${KEY}.inner.curiosity`), value: number(value.inner.curiosity) },
  ]
})

const openIntentions = computed(() => intentions.openAt(now.value.getTime()))
const usageToday = computed(() => usageByPurpose(usageRecords.value, usageDayOf(now.value.getTime())))

function number(value: number, digits = 2) {
  return value.toLocaleString(locale.value, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function timeLabel(epochMs: number) {
  return new Date(epochMs).toLocaleTimeString(locale.value, { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div :class="['flex flex-col', 'gap-4', 'pb-12']">
    <p :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
      {{ t(`${KEY}.intro`) }}
    </p>

    <section :class="['flex flex-col', 'gap-3', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <div :class="['flex items-baseline', 'gap-2']">
        <span :class="['min-w-0 flex-1', 'text-base font-medium']">{{ status }}</span>
        <span v-if="readout" :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
          {{ t(`${KEY}.mode`, { mode: readout.mode }) }}
        </span>
      </div>
      <p v-if="readout?.turn" :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.turn`, { trigger: readout.turn.trigger, type: readout.turn.speechType ?? '-' }) }}
      </p>

      <svg
        :viewBox="`0 0 ${GRAPH.width} ${GRAPH.height}`"
        preserveAspectRatio="none"
        :class="['h-30 w-full', 'rounded-lg', 'bg-white dark:bg-neutral-800/60']"
        role="img"
        :aria-label="t(`${KEY}.graph`)"
      >
        <polyline :points="graph.threshold" fill="none" stroke-width="1.5" stroke-dasharray="4 3" :class="['stroke-neutral-400']" vector-effect="non-scaling-stroke" />
        <polyline :points="graph.drive" fill="none" stroke-width="2" :class="['stroke-primary-500 dark:stroke-primary-400']" vector-effect="non-scaling-stroke" />
      </svg>
      <div :class="['flex flex-wrap items-center', 'gap-x-4 gap-y-1', 'text-xs', 'text-neutral-500 dark:text-neutral-400']">
        <span :class="['flex items-center', 'gap-1.5']">
          <span :class="['h-0.5 w-4', 'bg-primary-500 dark:bg-primary-400']" aria-hidden="true" />
          {{ t(`${KEY}.drive`) }}
        </span>
        <span :class="['flex items-center', 'gap-1.5']">
          <span :class="['h-0 w-4', 'border-t border-dashed border-neutral-400']" aria-hidden="true" />
          {{ t(`${KEY}.threshold`) }}
        </span>
        <span>{{ t(`${KEY}.last-minutes`, { count: 10 }) }}</span>
      </div>

      <dl v-if="readout" :class="['grid grid-cols-2 sm:grid-cols-4', 'gap-2', 'text-sm']">
        <div v-for="item in stats" :key="item.label" :class="['rounded-lg', 'bg-white dark:bg-neutral-800/60', 'px-3 py-2']">
          <dt :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
            {{ item.label }}
          </dt>
          <dd :class="['font-medium', 'tabular-nums']">
            {{ item.value }}
          </dd>
        </div>
      </dl>
      <p v-if="readout && !readout.jitterDrawn" :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.jitter-note`) }}
      </p>
    </section>

    <section v-if="readout" :class="['flex flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <h2 :class="['text-sm font-medium']">
        {{ t(`${KEY}.pace.title`) }}
      </h2>
      <ul :class="['flex flex-col', 'gap-1', 'text-sm', 'tabular-nums']">
        <li>{{ t(`${KEY}.pace.unanswered`, { count: readout.unanswered, factor: number(readout.intervalFactor) }) }}</li>
        <li>{{ t(`${KEY}.pace.budget`, { turns: readout.budget.turns, limit: readout.budget.limit }) }}</li>
        <li v-if="readout.refractoryLeftMs > 0">
          {{ t(`${KEY}.pace.refractory`, { seconds: Math.ceil(readout.refractoryLeftMs / 1_000) }) }}
        </li>
        <li>{{ t(`${KEY}.pace.recent-types`, { types: readout.recentTypes.join(', ') || '-' }) }}</li>
        <li v-if="rhythm?.awaySince">
          {{ t(`${KEY}.rhythm.away`, { time: timeLabel(rhythm.awaySince) }) }}
        </li>
        <li v-else>
          {{ t(`${KEY}.rhythm.present`) }}
        </li>
        <li v-if="rhythm?.lastRhythm">
          {{ t(`${KEY}.rhythm.${rhythm.lastRhythm.rhythm}`, { time: timeLabel(rhythm.lastRhythm.at) }) }}
        </li>
      </ul>
    </section>

    <section v-if="topics" :class="['flex flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <h2 :class="['text-sm font-medium']">
        {{ t(`${KEY}.topics.title`) }}
      </h2>
      <ul :class="['flex flex-col', 'gap-1', 'text-sm', 'tabular-nums']">
        <li v-if="topics.thread">
          {{ t(`${KEY}.topics.${topics.thread.cold ? 'thread-cold' : 'thread'}`, { topic: topics.thread.topic, count: topics.thread.lines, heat: number(topics.thread.heat) }) }}
        </li>
        <li v-else>
          {{ t(`${KEY}.topics.no-thread`) }}
        </li>
        <li>{{ t(`${KEY}.topics.seeds`, { seeds: topics.seeds.join(' / ') || '-' }) }}</li>
      </ul>
      <h3 :class="['mt-1', 'text-xs font-medium', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.topics.variety`, { count: topics.variety.lines }) }}
      </h3>
      <ul :class="['flex flex-col', 'gap-1', 'text-sm', 'tabular-nums']">
        <li>{{ t(`${KEY}.topics.distinct`, { value: number(topics.variety.distinct2) }) }}</li>
        <li>{{ t(`${KEY}.topics.entropy`, { value: number(topics.variety.typeEntropy) }) }}</li>
        <li>{{ t(`${KEY}.topics.similarity`, { value: topics.variety.topicSimilarity === undefined ? '-' : number(topics.variety.topicSimilarity) }) }}</li>
      </ul>
    </section>

    <section :class="['flex flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <h2 :class="['text-sm font-medium']">
        {{ t(`${KEY}.intentions`) }}
      </h2>
      <ul v-if="openIntentions.length" :class="['flex flex-col', 'gap-1', 'text-sm']">
        <li v-for="intention in openIntentions" :key="intention.id">
          {{ intention.text }}
          <span :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">· {{ t(`${KEY}.until`, { time: timeLabel(intention.expiresAt) }) }}</span>
        </li>
      </ul>
      <p v-else :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.none`) }}
      </p>

      <h2 :class="['mt-2', 'text-sm font-medium']">
        {{ t(`${KEY}.missions`) }}
      </h2>
      <ul v-if="activeMissions.length" :class="['flex flex-col', 'gap-1', 'text-sm']">
        <li v-for="mission in activeMissions" :key="mission.id">
          {{ mission.template === 'reminder' ? mission.values.text : t('settings.pages.modules.missions.small-talk.name') }}
          <span v-if="mission.template === 'small-talk'" :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">· {{ t(`${KEY}.until`, { time: timeLabel(mission.values.endsAt) }) }}</span>
          <span v-else-if="mission.nextRunAt" :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">· {{ timeLabel(mission.nextRunAt) }}</span>
        </li>
      </ul>
      <p v-else :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.none`) }}
      </p>

      <h2 :class="['mt-2', 'flex items-center', 'gap-2', 'text-sm font-medium']">
        <span :class="['min-w-0 flex-1']">{{ t('settings.pages.modules.initiative.talk-changes') }}</span>
        <GhostButton v-if="talkChanges.length" size="sm" icon="i-solar:restart-linear" @click="resetTalkChanges()">
          {{ t('settings.pages.modules.initiative.reset-talk-changes') }}
        </GhostButton>
      </h2>
      <ul v-if="talkChanges.length" :class="['flex flex-col', 'gap-1', 'text-sm']">
        <li v-for="change in talkChanges" :key="change">
          {{ change }}
        </li>
      </ul>
      <p v-else :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.modules.initiative.talk-changes-empty') }}
      </p>
    </section>

    <section :class="['flex flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <h2 :class="['text-sm font-medium']">
        {{ t(`${KEY}.usage-today`) }}
      </h2>
      <ul v-if="usageToday.length" :class="['flex flex-col', 'gap-1', 'text-sm', 'tabular-nums']">
        <li v-for="usage in usageToday" :key="usage.purpose" :class="['flex', 'gap-2']">
          <span :class="['min-w-0 flex-1']">{{ t(`settings.pages.usage.purposes.${usage.purpose}`) }}</span>
          <span>{{ t('settings.pages.usage.tokens', { count: usage.totalTokens.toLocaleString(locale) }) }}</span>
        </li>
      </ul>
      <p v-else :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.usage.empty') }}
      </p>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: tamagotchi.settings.devtools.pages.initiative-inspector.title
  subtitleKey: tamagotchi.settings.devtools.title
</route>
