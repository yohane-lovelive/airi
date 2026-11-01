import type { ForegroundWindow } from './exclusion'

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
   * Starts a capture. Resolves to a stream with a live video track. With `app`, the desktop captures the front window of
   * that app only, for example the game of a commentary. The web captures the share that the owner chooses.
   */
  start: (options?: { app?: string }) => Promise<MediaStream>
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
