import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { usePerceptionStore } from '../stores/perception'
import { usePerceptionRunnerStore } from '../stores/perception-runner'
import { usePerceptionStatusStore } from '../stores/perception-status'

/**
 * The stage indicator of screen perception: whether the character sees the screen, and one click to pause it.
 *
 * Use when:
 * - A stage control shows the perception indicator, for example the controls island or the chat header.
 *
 * Returns:
 * - `visible` while perception is on in an app that runs it, the icon, the label, `active` while frames come in,
 *   `recording` while the screen recorder writes, and `press` for the click. A press pauses or resumes. It starts the capture when it waits for a share or ended.
 */
export function usePerceptionIndicator() {
  const { t } = useI18n()
  const perception = usePerceptionStore()
  const { enabled, paused, supported } = storeToRefs(perception)
  const { status } = storeToRefs(usePerceptionStatusStore())
  const runner = usePerceptionRunnerStore()

  const needsStart = computed(() => !paused.value && ['needs-share', 'ended', 'failed'].includes(status.value.state))
  const active = computed(() => !paused.value && status.value.state === 'running')
  const visible = computed(() => enabled.value && supported.value)
  /** Whether the screen recorder writes frames to the disk now. The button then shows a red record mark. */
  const recording = computed(() => !paused.value && Boolean(status.value.recording))
  const icon = computed(() => {
    if (recording.value)
      return 'i-solar:record-circle-bold'
    if (paused.value)
      return 'i-solar:eye-closed-outline'
    return needsStart.value ? 'i-solar:eye-scan-outline' : 'i-solar:eye-outline'
  })
  const label = computed(() => {
    if (recording.value)
      return t('stage.perception.recording')
    if (paused.value)
      return t('stage.perception.resume')
    return needsStart.value ? t('stage.perception.start') : t('stage.perception.pause')
  })

  function press() {
    if (needsStart.value)
      void runner.startFromGesture()
    else
      perception.togglePaused()
  }

  return { visible, active, recording, icon, label, press }
}
