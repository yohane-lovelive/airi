import localforage from 'localforage'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from './auth'
import { useFeatureFlagsStore } from './feature-flags'
import { useMemoryStore } from './memory'
import { useMemoryRecallStore } from './memory-recall'

const { authedFetch } = vi.hoisted(() => ({
  authedFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))

// The server is the boundary. The fake answers the search route.
vi.mock('../libs/auth-fetch', () => ({ authedFetch }))

const records = localforage.createInstance({ name: 'airi-memory', storeName: 'entries' })

/** Other stores, for example the feature flags, also call the server. Only the search calls count here. */
function searchCalls() {
  return authedFetch.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/memories/search'))
}

/** Answers the search route with `answer`, and every other route with 404. */
function answerSearch(answer: () => Response) {
  authedFetch.mockImplementation(async url => String(url).endsWith('/api/v1/memories/search') ? answer() : new Response(null, { status: 404 }))
}

describe('memory recall store', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(async () => {
    await records.clear()
    authedFetch.mockReset()
    answerSearch(() => new Response(null, { status: 404 }))
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(async () => {
    disposePinia(pinia)
    await records.clear()
  })

  async function remember() {
    const memory = useMemoryStore()
    const ramen = (await memory.write({ description: '', body: '好物はラーメン' }, 'airi'))!
    const cat = (await memory.write({ description: '', body: '猫を飼っている' }, 'airi'))!
    return { ramen, cat }
  }

  it('recalls by shared characters while the memory sync is off, and asks no server', async () => {
    const { ramen } = await remember()

    const result = await useMemoryRecallStore().recall('ラーメンの話', 'airi')

    expect(result).toEqual({ mode: 'characters', entries: [ramen] })
    expect(searchCalls()).toEqual([])
    expect(useMemoryRecallStore().lastRecall).toMatchObject({ mode: 'characters', count: 1, queryChars: 6 })
  })

  it('asks the server while the memory sync runs, and falls back on a 503', async () => {
    useAuthStore().user = { id: 'user-1', name: 'user-1', email: 'user-1@example.test', emailVerified: true, createdAt: new Date(), updatedAt: new Date() }
    useFeatureFlagsStore().setPreference('memory-sync', true)
    const { cat } = await remember()
    answerSearch(() => Response.json({ records: [{ id: cat.id, score: 0.8 }] }))

    const byMeaning = await useMemoryRecallStore().recall('ペットはいる？', 'airi')

    expect(byMeaning).toEqual({ mode: 'meaning', entries: [cat] })
    const [[, init]] = searchCalls()
    expect(JSON.parse(String(init?.body))).toEqual({ query: 'ペットはいる？', personaId: 'airi', limit: 5 })

    answerSearch(() => Response.json({ error: 'EMBEDDER_UNAVAILABLE' }, { status: 503 }))
    expect((await useMemoryRecallStore().recall('猫', 'airi')).mode).toBe('characters')
  })
})
