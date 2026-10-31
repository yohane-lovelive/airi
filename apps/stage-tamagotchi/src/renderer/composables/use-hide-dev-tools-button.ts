import { useStyleTag } from '@vueuse/core'

/** The floating button and the component inspector that `vite-plugin-vue-devtools` adds to every page in development. */
const DEV_TOOLS_OVERLAY_SELECTOR = '#__vue-devtools-container__, #vue-inspector-container'

/**
 * Hides the Vue DevTools button in a transparent overlay window.
 *
 * Use when:
 * - The window paints almost nothing, for example the voice inlay, the floating chat, or the caption. In development,
 *   the button was the only thing that showed on the empty window, so the window looked like a stray frame beside the
 *   character.
 *
 * Expects:
 * - Development only. A packaged app has no DevTools button, so the call does nothing there.
 * - The main window and the settings window keep the button, so Vue DevTools stays in reach.
 */
export function useHideDevToolsButton() {
  if (!import.meta.env.DEV)
    return

  useStyleTag(`${DEV_TOOLS_OVERLAY_SELECTOR} { display: none !important; }`, { id: 'airi-hide-dev-tools-button' })
}
