import type { useElectronEventaContext } from '@proj-airi/electron-vueuse'
import type { ScreenCapture, ScreenSource } from '@proj-airi/stage-ui/libs/perception/screen-source'

import { defineInvoke } from '@moeru/eventa'
import { electronEvents } from '@proj-airi/electron-eventa'
import { useElectronScreenCapture } from '@proj-airi/electron-screen-capture/vue'
import { windowOfApp } from '@proj-airi/stage-ui/libs/perception/screen-source'

import { electronForegroundWindow, electronOpenWindows } from '../../shared/eventa'

/**
 * Lets screen perception capture the screen of the desktop.
 *
 * The capture takes the primary display without a prompt. A commentary captures one window of its app only. The main
 * process reads the window in front with its handle, so the exclusion list works also on a full display, and a
 * commentary can tell another window of its app. A screen lock or sleep interrupts the capture until the owner is back.
 */
export function createElectronScreenSource(context: ReturnType<typeof useElectronEventaContext>['value']): ScreenSource {
  const foregroundWindow = defineInvoke(context, electronForegroundWindow)
  const openWindows = defineInvoke(context, electronOpenWindows)
  const displays = useElectronScreenCapture(context, { types: ['screen'] })
  const windows = useElectronScreenCapture(context, { types: ['window'] })
  const capture = () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })

  /**
   * Captures one window of an app: the window of `windowId` while it is open, or else the front window of the app.
   * Windows names its window sources by the window handle.
   */
  async function startWindow(app: string, windowId?: number): Promise<ScreenCapture> {
    const open = (await openWindows()).filter(window => windowOfApp(window, app))
    const target = open.find(window => window.id === windowId) ?? open[0]
    if (!target)
      throw new Error(`No open window of ${app}.`)
    const stream = await windows.selectWithSource((sources) => {
      const source = sources.find(candidate => candidate.id.startsWith(`window:${target.id}:`))
      if (!source)
        throw new Error(`The window of ${app} cannot be captured.`)
      return source.id
    }, capture)
    return { stream, windowId: target.id }
  }

  return {
    supported: true,
    needsGesture: false,
    start: async options => options?.app
      ? startWindow(options.app, options.windowId)
      : {
          stream: await displays.selectWithSource(
            // The first screen source is the primary display.
            (sources) => {
              const display = sources.find(source => source.id.startsWith('screen:'))
              if (!display)
                throw new Error('No display to capture.')
              return display.id
            },
            capture,
          ),
        },
    windowOpen: async app => (await openWindows()).some(window => windowOfApp(window, app)),
    foreground: async () => {
      const window = await foregroundWindow()
      return window ? { id: window.id, title: window.title, app: window.app, path: window.path } : undefined
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
