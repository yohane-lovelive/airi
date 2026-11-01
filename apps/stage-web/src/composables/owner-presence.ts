import type { OwnerPresenceSource } from '@proj-airi/stage-ui/libs/initiative/presence'

import { useEventListener } from '@vueuse/core'

/**
 * Tells autonomous speech whether the owner uses this page.
 *
 * A browser page sees only its own input, so input in another tab or app counts as time away. The Idle Detection API
 * could see the whole device, but it asks the owner for a permission, so this source does not use it.
 * Call it in a component setup, because it listens to page events while the component lives.
 */
export function usePageOwnerPresence(): OwnerPresenceSource {
  let lastActiveAt = Date.now()
  const markActive = () => {
    lastActiveAt = Date.now()
  }
  for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const)
    useEventListener(window, event, markActive, { passive: true })
  useEventListener(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible')
      markActive()
  })

  return {
    idleMs: async () => Date.now() - lastActiveAt,
  }
}
