import type { useElectronEventaContext } from '@proj-airi/electron-vueuse'
import type { ScreenSource } from '@proj-airi/stage-ui/libs/perception/screen-source'

import { defineInvoke } from '@moeru/eventa'
import { electronEvents } from '@proj-airi/electron-eventa'
import { useElectronScreenCapture } from '@proj-airi/electron-screen-capture/vue'

import { electronForegroundWindow } from '../../shared/eventa'

/**
 * Lets screen perception capture the screen of the desktop.
 *
 * The capture takes the primary display without a prompt. The main process reads the window in front, so the
 * exclusion list works also on a full display. A screen lock or sleep interrupts the capture until the owner is back.
 */
export function createElectronScreenSource(context: ReturnType<typeof useElectronEventaContext>['value']): ScreenSource {
  const foregroundWindow = defineInvoke(context, electronForegroundWindow)
  const { selectWithSource } = useElectronScreenCapture(context, { types: ['screen'] })

  return {
    supported: true,
    needsGesture: false,
    start: () => selectWithSource(
      // The first screen source is the primary display.
      (sources) => {
        const display = sources.find(source => source.id.startsWith('screen:'))
        if (!display)
          throw new Error('No display to capture.')
        return display.id
      },
      () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }),
    ),
    foreground: async () => {
      const window = await foregroundWindow()
      return window ? { title: window.title, app: window.app, path: window.path } : undefined
    },
    onInterrupt: (listener) => {
      const stops = [
        context.on(electronEvents.powerMonitor.lockScreen, () => listener(true)),
        context.on(electronEvents.powerMonitor.suspended, () => listener(true)),
        context.on(electronEvents.powerMonitor.unlockScreen, () => listener(false)),
        context.on(electronEvents.powerMonitor.resumed, () => listener(false)),
      ]
      return () => {
        for (const stop of stops)
          stop()
      }
    },
  }
}
