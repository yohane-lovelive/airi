import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import { DEFAULT_PERCEPTION_EXCLUSIONS } from '../libs/perception/exclusion'

/**
 * The owner settings of screen perception: the character sees the screen of the device.
 * The device keeps them. Perception is off by default, because frames go to the cloud provider of the chat model.
 *
 * Use when:
 * - Settings show or change screen perception.
 * - The stage shows the perception indicator, and the owner pauses perception with one click.
 * - The perception runner reads whether to capture, and which windows to skip.
 *
 * Returns:
 * - The stored values, and `supported` for apps that run the perception runner.
 */
export const usePerceptionStore = defineStore('perception', () => {
  /** Whether the character sees the screen. Off by default. */
  const enabled = useLocalStorageManualReset<boolean>('perception/enabled', false)
  /** Whether the owner paused perception. The device keeps it, so a pause holds across a restart. */
  const paused = useLocalStorageManualReset<boolean>('perception/paused', false)
  /** Apps and words of window titles. A frame of a matching window in front is skipped. */
  const exclusions = useLocalStorageManualReset<string[]>('perception/exclusions', [...DEFAULT_PERCEPTION_EXCLUSIONS])
  /**
   * Whether this app runs screen perception. The perception runner sets it when an app initializes it with a source
   * that can capture, so Settings of another app can say that the feature does not run there.
   */
  const supported = ref(false)

  function togglePaused() {
    paused.value = !paused.value
  }

  function resetState() {
    enabled.reset()
    paused.reset()
    exclusions.reset()
  }

  return {
    enabled,
    paused,
    exclusions,
    supported,
    togglePaused,
    resetState,
  }
})
