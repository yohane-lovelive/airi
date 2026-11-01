import type { FramePolicyName } from '@proj-airi/stage-shared/perception'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import { DEFAULT_PERCEPTION_EXCLUSIONS } from '../libs/perception/exclusion'
import { IMAGE_BUDGET_LIMITS, imageBudgetState, imagesInWindow } from '../libs/perception/image-budget'

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
  /** The most frames that go to the model in one hour. Each frame of a decision turn counts. */
  const imagesPerHour = useLocalStorageManualReset<number>('perception/images-per-hour', IMAGE_BUDGET_LIMITS.defaultImagesPerHour)
  /** The budget while a commentary runs. It replaces the normal budget then, because commentary turns come often. */
  const commentaryImagesPerHour = useLocalStorageManualReset<number>('perception/commentary-images-per-hour', IMAGE_BUDGET_LIMITS.defaultCommentaryImagesPerHour)
  /**
   * The frame policy of decision turns, a developer setting. The default stays `fresh-keyframes` until replay
   * evaluation chooses one.
   */
  const framePolicy = useLocalStorageManualReset<FramePolicyName>('perception/frame-policy', 'fresh-keyframes')
  /** When frames went to the model, in the last hour. The device keeps them, so a restart does not reset the budget. */
  const sentImageTimes = useLocalStorageManualReset<number[]>('perception/sent-image-times', [])
  /**
   * Whether this app runs screen perception. The perception runner sets it when an app initializes it with a source
   * that can capture, so Settings of another app can say that the feature does not run there.
   */
  const supported = ref(false)

  function togglePaused() {
    paused.value = !paused.value
  }

  /** The image budget at `now`. A running commentary uses its own limit. Both count the same sent frames. */
  function budgetAt(now: number, commentary = false) {
    const wanted = commentary ? commentaryImagesPerHour.value : imagesPerHour.value
    const limit = Math.round(Math.min(IMAGE_BUDGET_LIMITS.maxImagesPerHour, Math.max(IMAGE_BUDGET_LIMITS.minImagesPerHour, wanted)))
    return imageBudgetState(sentImageTimes.value, limit, now)
  }

  /** Records frames that went to the model. Times older than the budget window drop out. */
  function recordImages(count: number, at: number) {
    sentImageTimes.value = [...imagesInWindow(sentImageTimes.value, at), ...Array.from<number>({ length: count }).fill(at)]
  }

  function resetState() {
    enabled.reset()
    paused.reset()
    exclusions.reset()
    imagesPerHour.reset()
    commentaryImagesPerHour.reset()
    framePolicy.reset()
    sentImageTimes.reset()
  }

  return {
    enabled,
    paused,
    exclusions,
    imagesPerHour,
    commentaryImagesPerHour,
    framePolicy,
    sentImageTimes,
    supported,
    togglePaused,
    budgetAt,
    recordImages,
    resetState,
  }
})
