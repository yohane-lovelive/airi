import type { Pinia } from 'pinia'

import { PiniaColada } from '@pinia/colada'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-vue'
import { page } from 'vitest/browser'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import ProviderGenerationSettings from './provider-generation-settings.vue'

import { useProviderConfigStore } from '../../../stores/providers/config'

const REASONING_KEY = 'settings.pages.providers.provider.openai-compatible.fields.field.reasoning-control'

async function mountSettings(pinia: Pinia, providerId: string) {
  const i18n = createI18n({
    // Every label resolves to its own key, which is a stable handle for the fields.
    legacy: false,
    locale: 'en',
    missingWarn: false,
    fallbackWarn: false,
    messages: { en: {} },
  })

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()

  return await render(ProviderGenerationSettings, {
    props: { providerId },
    global: { plugins: [pinia, PiniaColada, i18n, router] },
  })
}

describe('provider generation settings', () => {
  afterEach(() => {
    localStorage.clear()
  })

  // ROOT CAUSE:
  //
  // The chat provider page listed its fields by hand, so it never showed `reasoningControl`.
  // The field stayed `none`, and no reasoning level reached the server.
  //
  // This part now shows the field when the provider defines it.
  it('shows the reasoning request of a provider that defines it, and saves the choice', async () => {
    const pinia = createPinia()
    await mountSettings(pinia, 'openai-compatible')
    const store = useProviderConfigStore(pinia)
    store.ensureProvider('openai-compatible', 'openai-compatible', { baseUrl: 'https://example.com/v1/' })

    const field = page.getByRole('combobox', { name: new RegExp(`${REASONING_KEY}\\.label`) })
    await field.click()
    await expect.element(page.getByRole('option', { name: `${REASONING_KEY}.options.none` })).toBeVisible()
    await expect.element(page.getByRole('option', { name: `${REASONING_KEY}.options.reasoning-effort` })).toBeVisible()
    await page.getByRole('option', { name: `${REASONING_KEY}.options.thinking` }).click()

    await expect.poll(() => store.getProviderConfig('openai-compatible')?.reasoningControl).toBe('thinking')
  })

  it('shows no reasoning request for a provider without the field', async () => {
    const pinia = createPinia()
    await mountSettings(pinia, 'openai')
    useProviderConfigStore(pinia).ensureProvider('openai', 'openai', {})

    await expect.element(page.getByRole('combobox', { name: /api-protocol\.label/ })).toBeVisible()
    expect(page.getByRole('combobox', { name: new RegExp(`${REASONING_KEY}\\.label`) }).elements()).toHaveLength(0)
  })
})
