import type { CharacterAttentionTarget } from '@proj-airi/stage-shared/stage-sidecar'
import type { MaybeRefOrGetter } from 'vue'

import { onScopeDispose, toValue, watch } from 'vue'

/** After AIRI stops thinking and speaking, the character still looks at the viewer this long, as a person does. */
const RELEASE_DELAY_MS = 15_000

/**
 * Tells a sidecar when the character turns to the viewer.
 *
 * The target is `viewer` while `isEngaged` is true, and for 15 seconds after it ends. A new engagement in these 15
 * seconds keeps `viewer`. Only a change reaches `send`, because the sidecar keeps the last target.
 *
 * Owned state: the last target and the release timer. While `active` is false, both reset and nothing is sent, because
 * no sidecar draws the character. When `active` returns, an engagement sends `viewer` again.
 */
export function useStageSidecarAttention(params: {
  active: MaybeRefOrGetter<boolean>
  /** True while AIRI thinks or speaks. */
  isEngaged: () => boolean
  send: (target: CharacterAttentionTarget) => void
}) {
  let target: CharacterAttentionTarget = 'none'
  let releaseTimer: ReturnType<typeof setTimeout> | undefined

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

  watch([() => toValue(params.active), params.isEngaged], ([active, engaged]) => {
    if (!active) {
      cancelRelease()
      target = 'none'
      return
    }

    if (engaged) {
      cancelRelease()
      change('viewer')
      return
    }

    if (target === 'viewer' && releaseTimer === undefined) {
      releaseTimer = setTimeout(() => {
        releaseTimer = undefined
        change('none')
      }, RELEASE_DELAY_MS)
    }
  }, { immediate: true })

  onScopeDispose(cancelRelease)
}
