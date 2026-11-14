import type { MaybeRefOrGetter } from 'vue'

import { encodeBase64 } from '@moeru/std/base64'
import { ROOM_SCREEN_MAX_LENGTH } from '@proj-airi/stage-shared/stage-sidecar'
import { onScopeDispose, toValue, watch } from 'vue'

/**
 * Sends the frames of a commentary to the screen of a sidecar room, so the game shows on a monitor of the room.
 *
 * The frames come from perception, so its rules hold: only the watched window, only while it is in view. While
 * `active` is false, no frame goes. A frame that comes while the last one is still in work is dropped, so a slow
 * moment sends fewer frames and no queue grows. The frames stay in memory.
 *
 * Owned state: the subscription to the frames while `active` is true, and whether a frame is in work.
 */
export function useStageSidecarScreen(params: {
  /** True while a sidecar draws the character and a commentary runs. */
  active: MaybeRefOrGetter<boolean>
  /** Starts the frames for a listener, and returns the function that stops them. */
  subscribe: (listener: (image: Blob) => void) => () => void
  /** Gets a JPEG in base64. */
  send: (image: string) => void
}) {
  let stop: (() => void) | undefined
  let working = false

  async function forward(image: Blob) {
    if (working)
      return
    working = true
    try {
      const base64 = encodeBase64(new Uint8Array(await image.arrayBuffer()))
      // The commentary can end during the read, and the protocol refuses a frame that is too large.
      if (stop && base64.length <= ROOM_SCREEN_MAX_LENGTH)
        params.send(base64)
    }
    finally {
      working = false
    }
  }

  function unsubscribe() {
    stop?.()
    stop = undefined
  }

  watch(() => toValue(params.active), (active) => {
    unsubscribe()
    if (active)
      stop = params.subscribe(image => void forward(image))
  }, { immediate: true })

  onScopeDispose(unsubscribe)
}
