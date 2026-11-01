import type { ScreenSource } from '@proj-airi/stage-ui/libs/perception/screen-source'

/** Whether the browser can share a screen. Phone browsers cannot, so perception stays off there. */
function canShareScreen() {
  if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getDisplayMedia !== 'function')
    return false
  return !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

/**
 * Lets screen perception capture a share that the owner chooses.
 *
 * The browser asks the owner to choose a share after each page load, so a start runs from a click. The page cannot
 * tell the window in front, so the exclusion list cannot work. The picker therefore offers a window first, and it
 * leaves out the AIRI tab itself.
 */
export function createPageScreenSource(): ScreenSource {
  return {
    supported: canShareScreen(),
    needsGesture: true,
    start: () => navigator.mediaDevices.getDisplayMedia(({
      video: { displaySurface: 'window' },
      audio: false,
      selfBrowserSurface: 'exclude',
    })),
  }
}
