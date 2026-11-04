import type { MotionGeneratorConnection, MotionGeneratorStatus } from './motion-generation'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useMotionGenerationStore } from './motion-generation'

const { addGenerated, record } = vi.hoisted(() => ({
  addGenerated: vi.fn(),
  record: vi.fn(),
}))

// The library reads IndexedDB and three.js, and the usage store reads IndexedDB. Both are the boundary here.
vi.mock('./motion-library', () => ({
  useMotionLibraryStore: () => ({ addGenerated }),
}))
vi.mock('./usage', () => ({
  useUsageStore: () => ({ record }),
}))

const status: MotionGeneratorStatus = { baseUrl: 'http://127.0.0.1:8787', hasToken: true, tokenPreview: '••••abcd', enabled: true, dailyLimit: 5, usedToday: 0 }

function fakeGenerator(overrides: Partial<MotionGeneratorConnection> = {}) {
  return {
    getConfig: vi.fn(async () => status),
    setConfig: vi.fn(async () => status),
    check: vi.fn(async () => true),
    generate: vi.fn(async () => new Uint8Array([0x67, 0x6C, 0x54, 0x46])),
    ...overrides,
  }
}

async function settle() {
  for (let round = 0; round < 10; round++)
    await Promise.resolve()
}

describe('motion generation store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    addGenerated.mockReset().mockResolvedValue({ id: 'g1' })
    record.mockReset()
  })

  it('generates nothing without a connection, for example in the web app', () => {
    expect(useMotionGenerationStore().request('swing a sword')).toBe(false)
  })

  it('waits for the end of a chat turn, then adds the clip and counts one call', async () => {
    const store = useMotionGenerationStore()
    const generator = fakeGenerator()
    store.connect(generator)
    store.setBusy(true)

    expect(store.request('swing a sword')).toBe(true)
    await settle()
    expect(generator.generate).not.toHaveBeenCalled()

    store.setBusy(false)
    await vi.waitFor(() => expect(record).toHaveBeenCalled())
    expect(generator.generate).toHaveBeenCalledWith({ prompt: 'swing a sword' })
    expect(addGenerated).toHaveBeenCalledWith('swing a sword', expect.any(ArrayBuffer))
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'motion', model: 'text-to-vrma', calls: 1, images: 0 }))
  })

  it('runs one generation at a time, in order', async () => {
    const store = useMotionGenerationStore()
    let finish: (bytes: Uint8Array) => void = () => {}
    const generator = fakeGenerator({
      generate: vi.fn(() => new Promise<Uint8Array>((resolve) => {
        finish = resolve
      })),
    })
    store.connect(generator)

    store.request('swing a sword')
    store.request('jump')
    await settle()
    expect(generator.generate).toHaveBeenCalledTimes(1)
    expect(store.queue).toEqual(['jump'])

    finish(new Uint8Array(4))
    await vi.waitFor(() => expect(generator.generate).toHaveBeenCalledTimes(2))
    expect(generator.generate).toHaveBeenLastCalledWith({ prompt: 'jump' })
  })

  it('skips a motion that waits or ran, and keeps at most 3 waiting', async () => {
    const store = useMotionGenerationStore()
    store.connect(fakeGenerator())
    store.setBusy(true)

    expect(store.request('a')).toBe(true)
    expect(store.request(' A ')).toBe(false)
    expect(store.request('b')).toBe(true)
    expect(store.request('c')).toBe(true)
    expect(store.request('d')).toBe(false)
  })

  it('tries a failed motion once in each run of the app', async () => {
    const store = useMotionGenerationStore()
    const generator = fakeGenerator({ generate: vi.fn(async () => Promise.reject(new Error('ARDY is not ready'))) })
    store.connect(generator)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    store.request('swing a sword')
    await vi.waitFor(() => expect(store.running).toBeUndefined())
    await settle()

    expect(store.request('swing a sword')).toBe(false)
    expect(generator.generate).toHaveBeenCalledTimes(1)
  })

  it('drops the queue when the owner turned generation off or the day reached its limit', async () => {
    for (const config of [{ ...status, enabled: false }, { ...status, usedToday: 5 }]) {
      setActivePinia(createPinia())
      const store = useMotionGenerationStore()
      const generator = fakeGenerator({ getConfig: vi.fn(async () => config) })
      store.connect(generator)
      store.setBusy(true)
      store.request('a')
      store.request('b')

      store.setBusy(false)
      await vi.waitFor(() => expect(store.running).toBeUndefined())
      await settle()

      expect(generator.generate).not.toHaveBeenCalled()
      expect(store.queue).toEqual([])
    }
  })
})
