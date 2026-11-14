import type { ForegroundWindow } from './exclusion'

/**
 * Whether a window belongs to the app that the owner named for a commentary. Case does not count, and a part of the
 * app name or of the title counts, so "League" finds "League of Legends" and a title finds a window of a browser.
 *
 * The capture finds the window and the runner checks the window in front with this one rule. A live check on
 * 2026-11-04 found that the front check read only the app name, so a commentary of a title never took a frame.
 *
 * @example
 * windowOfApp({ app: 'Electron', title: 'DEMO ARENA' }, 'demo arena')
 * // => true
 */
export function windowOfApp(window: Pick<ForegroundWindow, 'app' | 'title'>, app: string): boolean {
  const wanted = app.trim().toLowerCase()
  if (!wanted)
    return false
  return window.app.toLowerCase().includes(wanted) || window.title.toLowerCase().includes(wanted)
}

/** A capture that a screen source started. */
export interface ScreenCapture {
  /** The stream, with a live video track. */
  readonly stream: MediaStream
  /** The handle of the captured window, where the device tells it. A display and a share of the web have none. */
  readonly windowId?: number
}

/**
 * Where an app captures the screen. Each app passes its own source to the perception runner.
 *
 * - The desktop app captures a display without a prompt, and it knows the window in front.
 * - The web app asks the owner to choose a share after each page load, so a start needs a click.
 */
export interface ScreenSource {
  /** Whether this device can capture the screen. A phone browser cannot. */
  readonly supported: boolean
  /** Whether a start must run inside a click of the owner. */
  readonly needsGesture: boolean
  /**
   * Starts a capture. With `app`, the desktop captures one window of that app only, for example the game of a
   * commentary: the window that `windowId` names while it is open, or else the front window of the app. The web
   * captures the share that the owner chooses.
   */
  start: (options?: { app?: string, windowId?: number }) => Promise<ScreenCapture>
  /** Whether a window of the app is still open. Undefined where the device cannot tell it. */
  windowOpen?: (app: string) => Promise<boolean>
  /** The window in front. Undefined where the device cannot tell it, for example on the web. */
  foreground?: () => Promise<ForegroundWindow | undefined>
  /**
   * Calls the listener with `true` when the screen locks or the device sleeps, and with `false` when it comes back.
   * Resolves to a function that removes the listener.
   */
  onInterrupt?: (listener: (interrupted: boolean) => void) => () => void
}
