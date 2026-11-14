import type { useElectronEventaContext } from '@proj-airi/electron-vueuse'
import type { OwnerPresenceSource } from '@proj-airi/stage-ui/libs/initiative/presence'

import { defineInvoke } from '@moeru/eventa'
import { electronEvents } from '@proj-airi/electron-eventa'

import { electronSystemIdleSeconds } from '../../shared/eventa'

/**
 * Tells autonomous speech whether the owner is at the computer.
 *
 * The idle time counts input in every app, not only in AIRI, so the owner who works in another app is present.
 * A screen lock or sleep means that the owner left at once.
 */
export function createElectronOwnerPresenceSource(context: ReturnType<typeof useElectronEventaContext>['value']): OwnerPresenceSource {
  const systemIdleSeconds = defineInvoke(context, electronSystemIdleSeconds)
  return {
    idleMs: async () => await systemIdleSeconds() * 1_000,
    onAway: (listener) => {
      const stops = [
        context.on(electronEvents.powerMonitor.lockScreen, () => listener()),
        context.on(electronEvents.powerMonitor.suspended, () => listener()),
      ]
      return () => {
        for (const stop of stops)
          stop()
      }
    },
  }
}
