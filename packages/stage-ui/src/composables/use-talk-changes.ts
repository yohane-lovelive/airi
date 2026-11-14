import { activeTalkControl } from '@proj-airi/core-agent'
import { useNow } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useInitiativeStore } from '../stores/initiative'

const KEY = 'settings.pages.modules.initiative'

/**
 * The owner's temporary talk changes as text, for example "Quiet until 11:57".
 *
 * Use when:
 * - A view lists the changes from the owner's words and offers a reset, for example Settings or the inspector.
 *
 * Returns:
 * - `changes`, one line for each active change. A change ends on its own, so the list reads the clock each 30 seconds.
 * - `reset`, which ends every change.
 */
export function useTalkChanges() {
  const { t, locale } = useI18n()
  const initiative = useInitiativeStore()
  const { talkControl } = storeToRefs(initiative)
  const now = useNow({ interval: 30_000 })

  function timeLabel(epochMs: number) {
    return new Date(epochMs).toLocaleTimeString(locale.value, { hour: '2-digit', minute: '2-digit' })
  }

  const changes = computed(() => {
    const active = activeTalkControl(talkControl.value, now.value.getTime())
    const lines: string[] = []
    if (active.quietUntil !== undefined)
      lines.push(t(`${KEY}.quiet-until`, { time: timeLabel(active.quietUntil) }))
    if (active.interval) {
      const factor = active.interval.factor.toLocaleString(locale.value, { maximumFractionDigits: 2 })
      lines.push(t(`${KEY}.interval-until`, { factor, time: timeLabel(active.interval.until) }))
    }
    return lines
  })

  return {
    changes,
    reset: () => initiative.resetTalkControl(),
  }
}
