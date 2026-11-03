import en from '@proj-airi/i18n/locales/en'

import { BUILT_IN_GESTURES } from '@proj-airi/stage-shared/body-motion'
import { useMotionLibraryStore } from '@proj-airi/stage-ui/stores/motion-library'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render } from 'vitest-browser-vue'
import { createI18n } from 'vue-i18n'

import MotionsPage from './motions.vue'

import 'virtual:uno.css'

describe('motions settings page', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(async () => {
    pinia = createPinia()
    setActivePinia(pinia)
    await useMotionLibraryStore().resetState()
  })

  afterEach(async () => {
    cleanup()
    await useMotionLibraryStore().resetState()
    disposePinia(pinia)
  })

  function renderPage() {
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
    return render(MotionsPage, { global: { plugins: [pinia, i18n] } })
  }

  it('lists the built-in gestures, turns one off, and asks the stage for a preview', async () => {
    const library = useMotionLibraryStore()
    const screen = renderPage()

    for (const gesture of BUILT_IN_GESTURES)
      await expect.element(screen.getByText(gesture.description)).toBeVisible()

    await screen.getByRole('switch', { name: /^wave/ }).click()
    await expect.poll(() => library.entries.find(entry => entry.id === 'wave')?.enabled).toBe(false)

    await screen.getByRole('button', { name: 'Play nod on the stage' }).click()
    // The request goes to the stage of the other windows, so this window keeps no request of its own.
    expect(screen.getByRole('button', { name: 'Remove nod' }).query()).toBeNull()
  })
})
