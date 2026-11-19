import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type { DesktopWindowInfo } from '../../../shared/eventa'

import process from 'node:process'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { desktopCapturer } from 'electron'

import { electronForegroundWindow, electronOpenWindows } from '../../../shared/eventa'

const log = useLogg('main/foreground-window').useGlobalConfig()

/** The id of a window source of `desktopCapturer` holds the window handle: `window:<handle>:<index>`. */
const WINDOW_SOURCE_ID = /^window:(\d+):/

/**
 * Adds the windows that Electron can capture and the window list does not hold. An added window has its title only,
 * and it comes after the listed windows.
 *
 * @param listed The open windows, front to back.
 * @param sources The window sources of `desktopCapturer`.
 *
 * @example
 * withCapturableWindows([], [{ id: 'window:69246:0', name: 'Some Game' }])
 * // => [{ id: 69246, title: 'Some Game', app: '', path: '' }]
 */
export function withCapturableWindows(listed: readonly DesktopWindowInfo[], sources: readonly { id: string, name: string }[]): DesktopWindowInfo[] {
  const known = new Set(listed.map(window => window.id))
  const added = sources.flatMap((source) => {
    const id = Number(WINDOW_SOURCE_ID.exec(source.id)?.[1])
    if (!Number.isSafeInteger(id) || known.has(id) || !source.name.trim())
      return []
    known.add(id)
    return [{ id, title: source.name, app: '', path: '' }]
  })
  return [...listed, ...added]
}

/**
 * Answers which window is in front on the whole system, and which windows are open. Electron cannot tell it, so
 * `get-windows` reads it. On Windows, the window sources of Electron add the windows that `get-windows` skips.
 * Other systems read no window sources, because that read can open a permission prompt on macOS.
 *
 * The package is native and ESM only, so it loads on the first call. On macOS, the permission checks stay off: a
 * title then reads as empty, and no system prompt opens from a background read.
 */
export function createForegroundWindowService(params: { context: ReturnType<typeof createContext>['context'] }) {
  let reader: Promise<typeof import('get-windows')> | undefined
  // Perception asks twice a second, so a broken reader logs once.
  let warned = false
  let warnedSources = false

  defineInvokeHandler(params.context, electronForegroundWindow, async (): Promise<DesktopWindowInfo | undefined> => {
    try {
      reader ??= import('get-windows')
      const { activeWindow } = await reader
      const window = await activeWindow({ accessibilityPermission: false, screenRecordingPermission: false })
      if (!window)
        return undefined
      return { id: window.id, title: window.title, app: window.owner.name, path: window.owner.path }
    }
    catch (error) {
      if (!warned)
        log.withError(error).warn('Failed to read the window in front')
      warned = true
      return undefined
    }
  })

  defineInvokeHandler(params.context, electronOpenWindows, async (): Promise<DesktopWindowInfo[]> => {
    try {
      reader ??= import('get-windows')
      const { openWindows } = await reader
      const windows = await openWindows({ accessibilityPermission: false, screenRecordingPermission: false })
      const listed = windows.map(window => ({ id: window.id, title: window.title, app: window.owner.name, path: window.owner.path }))
      // NOTICE:
      // On Windows, `get-windows` 9.3.0 skips a window without a caption or the popup style, for example the
      // launcher of a game. Root cause: `EnumDekstopWindowsProc` in its `Sources/windows/main.cc`.
      // Source: ADR 2026-11-14, step 8.
      // Remove this when `openWindows` lists such a window.
      if (process.platform !== 'win32')
        return listed
      try {
        return withCapturableWindows(listed, await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }))
      }
      catch (error) {
        if (!warnedSources)
          log.withError(error).warn('Failed to read the window sources')
        warnedSources = true
        return listed
      }
    }
    catch (error) {
      log.withError(error).warn('Failed to read the open windows')
      return []
    }
  })
}
