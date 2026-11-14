import type { MotionGeneratorStatus } from '@proj-airi/stage-ui/stores/motion-generation'

import en from '@proj-airi/i18n/locales/en'

import { BUILT_IN_GESTURES } from '@proj-airi/stage-shared/body-motion'
import { animations } from '@proj-airi/stage-ui-three/assets/vrm'
import { useMotionGenerationStore } from '@proj-airi/stage-ui/stores/motion-generation'
import { useMotionLibraryStore } from '@proj-airi/stage-ui/stores/motion-library'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('asks the owner to keep or remove a generated clip', async () => {
    const library = useMotionLibraryStore()
    await library.ready()
    // The idle loop stands in for a clip of the generator.
    await library.addGenerated('swing a sword', await (await fetch(animations.idleLoop.toString())).arrayBuffer())
    const screen = renderPage()

    await expect.element(screen.getByText(/Generated · Not kept yet/)).toBeVisible()
    await screen.getByRole('button', { name: 'Keep swing a sword' }).click()
    await expect.poll(() => library.entries.find(entry => entry.name === 'swing a sword')?.kept).toBe(true)
    expect(screen.getByRole('button', { name: 'Keep swing a sword' }).query()).toBeNull()
    await expect.element(screen.getByRole('button', { name: 'Remove swing a sword' })).toBeVisible()
  })

  it('says that generation needs the desktop app when no app gives a generator', async () => {
    const screen = renderPage()

    await expect.element(screen.getByText(/Motion generation works in the desktop app/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Test connection' }).query()).toBeNull()
  })

  it('reads and writes the settings of the generator through the connection, and never shows the token', async () => {
    let status: MotionGeneratorStatus = { baseUrl: 'http://127.0.0.1:8787', hasToken: false, tokenPreview: '', enabled: false, dailyLimit: 5, usedToday: 2, lastError: 'ARDY is not ready' }
    const setConfig = vi.fn(async (update: Partial<MotionGeneratorStatus> & { token?: string }) => {
      const { token, ...rest } = update
      status = { ...status, ...rest, ...(token ? { hasToken: true, tokenPreview: '••••••••abcd' } : {}) }
      return status
    })
    useMotionGenerationStore().connect({
      getConfig: async () => status,
      setConfig,
      check: async () => true,
      generate: async () => new Uint8Array(),
    })
    const screen = renderPage()

    await expect.element(screen.getByText('2 of 5 today')).toBeVisible()
    await expect.element(screen.getByText('Last failure: ARDY is not ready')).toBeVisible()

    await screen.getByRole('switch', { name: /^Generate missing motions/ }).click()
    await expect.poll(() => setConfig.mock.calls.at(-1)?.[0]).toEqual({ enabled: true })

    await screen.getByLabelText('Access token').fill('secret-abcd')
    await screen.getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => setConfig.mock.calls.at(-1)?.[0]).toEqual({ baseUrl: 'http://127.0.0.1:8787', token: 'secret-abcd' })
    await expect.element(screen.getByPlaceholder('••••••••abcd')).toBeVisible()

    await screen.getByRole('button', { name: 'Test connection' }).click()
    await expect.element(screen.getByText('Text-To-VRMA answered.')).toBeVisible()
  })
})
