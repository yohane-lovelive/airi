import type { CharacterActivity, CharacterAttentionTarget } from '@proj-airi/stage-shared/stage-sidecar'
import type { MaybeRefOrGetter } from 'vue'

import { onScopeDispose, toValue, watch } from 'vue'

/** After AIRI stops thinking and speaking, the character still looks at the viewer this long, as a person does. */
const RELEASE_DELAY_MS = 15_000

/** During a commentary, she looks at the game again soon after a line, because the game goes on. */
const COMMENTARY_RELEASE_DELAY_MS = 2_000

/**
 * Tells a sidecar what the character does, and when she turns to the viewer.
 *
 * The activity is `watching-screen` while a commentary runs, and `none` otherwise. The attention depends on it:
 * - Without a commentary, the target is `viewer` while AIRI thinks or speaks, and for 15 seconds after that.
 * - During a commentary, the target is `viewer` only while AIRI speaks, and for 2 seconds after that. Most turns of a
 *   commentary start from the screen, not from the owner, so a thought does not count.
 *
 * A new engagement before the release keeps `viewer`. Only a change reaches `send` or `sendActivity`, because the
 * sidecar keeps the last values.
 *
 * Owned state: the last target, the last activity, and the release timer. While `active` is false, all reset and
 * nothing is sent, because no sidecar draws the character. When `active` returns, the current values go again.
 */
export function useStageSidecarAttention(params: {
  active: MaybeRefOrGetter<boolean>
  isThinking: () => boolean
  isSpeaking: () => boolean
  /** True while a commentary runs. */
  isCommenting: () => boolean
  send: (target: CharacterAttentionTarget) => void
  sendActivity: (activity: CharacterActivity) => void
}) {
  let target: CharacterAttentionTarget = 'none'
  let activity: CharacterActivity = 'none'
  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  let releaseDelay = 0

  function cancelRelease() {
    clearTimeout(releaseTimer)
    releaseTimer = undefined
  }

  function change(next: CharacterAttentionTarget) {
    if (next === target)
      return

    target = next
    params.send(next)
  }

  function changeActivity(next: CharacterActivity) {
    if (next === activity)
      return

    activity = next
    params.sendActivity(next)
  }

  watch([() => toValue(params.active), params.isThinking, params.isSpeaking, params.isCommenting], ([active, thinking, speaking, commenting]) => {
    if (!active) {
      cancelRelease()
      target = 'none'
      activity = 'none'
      return
    }

    changeActivity(commenting ? 'watching-screen' : 'none')
    if (speaking || (thinking && !commenting)) {
      cancelRelease()
      change('viewer')
      return
    }

    // A commentary that starts or ends during a release changes its delay, so the release starts again.
    const delay = commenting ? COMMENTARY_RELEASE_DELAY_MS : RELEASE_DELAY_MS
    if (target === 'viewer' && (releaseTimer === undefined || releaseDelay !== delay)) {
      cancelRelease()
      releaseDelay = delay
      releaseTimer = setTimeout(() => {
        releaseTimer = undefined
        change('none')
      }, delay)
    }
  }, { immediate: true })

  onScopeDispose(cancelRelease)
}
