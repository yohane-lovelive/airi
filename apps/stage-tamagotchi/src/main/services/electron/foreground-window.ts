import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type { ForegroundWindowInfo } from '../../../shared/eventa'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'

import { electronForegroundWindow } from '../../../shared/eventa'

const log = useLogg('main/foreground-window').useGlobalConfig()

/**
 * Answers which window is in front on the whole system. Electron cannot tell it, so `get-windows` reads it.
 *
 * The package is native and ESM only, so it loads on the first call. On macOS, the permission checks stay off: a
 * title then reads as empty, and no system prompt opens from a background read.
 */
export function createForegroundWindowService(params: { context: ReturnType<typeof createContext>['context'] }) {
  let reader: Promise<typeof import('get-windows')> | undefined
  // Perception asks twice a second, so a broken reader logs once.
  let warned = false

  defineInvokeHandler(params.context, electronForegroundWindow, async (): Promise<ForegroundWindowInfo | undefined> => {
    try {
      reader ??= import('get-windows')
      const { activeWindow } = await reader
      const window = await activeWindow({ accessibilityPermission: false, screenRecordingPermission: false })
      if (!window)
        return undefined
      return { title: window.title, app: window.owner.name, path: window.owner.path }
    }
    catch (error) {
      if (!warned)
        log.withError(error).warn('Failed to read the window in front')
      warned = true
      return undefined
    }
  })
}
