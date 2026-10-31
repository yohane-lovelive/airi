import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '../stores/auth'
import { resolveCloudUrl, useCloudFetch } from './cloud'

describe('cloud request boundary', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    vi.stubEnv('VITE_CLOUD_URL', 'https://cloud.example.test')
  })

  afterEach(() => {
    disposePinia(pinia)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('uses the configured Cloud origin, current bearer, and caller cancellation', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ flags: [] }))
    useAuthStore().token = 'test-access-token'
    const controller = new AbortController()
    await useCloudFetch()('/v1/feature-flags', { signal: controller.signal })
    expect(network).toHaveBeenCalledTimes(1)
    const [url, init] = network.mock.calls[0]!
    expect(String(url)).toBe('https://cloud.example.test/v1/feature-flags')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-access-token')
    expect(init?.credentials).toBe('omit')
    expect(init?.signal).toBe(controller.signal)
  })

  it('supports anonymous requests and does not invent a bearer', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ flags: [] }))
    useAuthStore().token = null
    await useCloudFetch()('/v1/feature-flags')
    expect(new Headers(network.mock.calls[0]![1]?.headers).has('Authorization')).toBe(false)
  })

  // ROOT CAUSE:
  //
  // With a self-hosted server, sign-in sent the local token to the hosted Cloud. The Cloud answered 401, and
  // `authedFetch` ended the session, so every sign-in ended in a sign-out.
  //
  // We fixed this by giving a server outside `airi.build` no Cloud unless `VITE_CLOUD_URL` names one.
  it('gives a self-hosted server no Cloud unless one is configured', () => {
    vi.stubEnv('VITE_CLOUD_URL', '')

    expect(resolveCloudUrl('https://api.airi.build')).toBe('https://cloud.airi.build')
    expect(resolveCloudUrl('http://localhost:6112')).toBeUndefined()
    expect(resolveCloudUrl('https://airi.build.example.test')).toBeUndefined()

    vi.stubEnv('VITE_CLOUD_URL', 'https://cloud.example.test')
    expect(resolveCloudUrl('http://localhost:6112')).toBe('https://cloud.example.test')
  })

  it('rejects off-origin URLs before sending account credentials', () => {
    const network = vi.spyOn(globalThis, 'fetch')
    const cloudFetch = useCloudFetch()
    expect(() => cloudFetch('https://other.example.test/flags')).toThrow('Cloud origin')
    expect(() => cloudFetch('//other.example.test/flags')).toThrow('Cloud origin')
    expect(network).not.toHaveBeenCalled()
  })
})
