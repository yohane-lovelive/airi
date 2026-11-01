import type { useElectronEventaContext } from '@proj-airi/electron-vueuse'
import type { ScreenSource } from '@proj-airi/stage-ui/libs/perception/screen-source'

import { defineInvoke } from '@moeru/eventa'
import { electronEvents } from '@proj-airi/electron-eventa'
import { useElectronScreenCapture } from '@proj-airi/electron-screen-capture/vue'

import { electronForegroundWindow, electronOpenWindows } from '../../shared/eventa'

/** Whether a window belongs to the app that the owner named. Names match without case, and a part of the name counts. */
function windowOfApp(window: { app: string, title: string }, app: string) {
  const wanted = app.toLowerCase()
  return window.app.toLowerCase() === wanted || window.app.toLowerCase().includes(wanted) || window.title.toLowerCase().includes(wanted)
}

/**
 * Lets screen perception capture the screen of the desktop.
 *
 * The capture takes the primary display without a prompt. A commentary captures the front window of its app only. The main process reads the window in front, so the
 * exclusion list works also on a full display. A screen lock or sleep interrupts the capture until the owner is back.
 */
export function createElectronScreenSource(context: ReturnType<typeof useElectronEventaContext>['value']): ScreenSource {
  const foregroundWindow = defineInvoke(context, electronForegroundWindow)
  const openWindows = defineInvoke(context, electronOpenWindows)
  const displays = useElectronScreenCapture(context, { types: ['screen'] })
  const windows = useElectronScreenCapture(context, { types: ['window'] })
  const capture = () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })

  /** Captures the front window of an app. Windows names its window sources by the window handle. */
  async function startWindow(app: string) {
    const target = (await openWindows()).find(window => windowOfApp(window, app))
    if (!target)
      throw new Error(`No open window of ${app}.`)
    return windows.selectWithSource((sources) => {
      const source = sources.find(candidate => candidate.id.startsWith(`window:${target.id}:`))
      if (!source)
        throw new Error(`The window of ${app} cannot be captured.`)
      return source.id
    }, capture)
  }

  return {
    supported: true,
    needsGesture: false,
    start: options => options?.app
      ? startWindow(options.app)
      : displays.selectWithSource(
          // The first screen source is the primary display.
          (sources) => {
            const display = sources.find(source => source.id.startsWith('screen:'))
            if (!display)
              throw new Error('No display to capture.')
            return display.id
          },
          capture,
        ),
    windowOpen: async app => (await openWindows()).some(window => windowOfApp(window, app)),
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
