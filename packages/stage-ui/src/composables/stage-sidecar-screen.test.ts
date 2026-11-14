import { decodeBase64 } from '@moeru/std/base64'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

import { useStageSidecarScreen } from './stage-sidecar-screen'

describe('useStageSidecarScreen', () => {
  function setup(initiallyActive = false) {
    const active = ref(initiallyActive)
    const listeners = new Set<(image: Blob) => void>()
    const subscribe = vi.fn((listener: (image: Blob) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
    const sent: string[] = []
    const scope = effectScope()
    onTestFinished(() => scope.stop())
    scope.run(() => useStageSidecarScreen({ active, subscribe, send: image => sent.push(image) }))
    const emit = (bytes: number[]) => {
      for (const listener of listeners)
        listener(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }))
    }
    return { active, emit, listeners, scope, sent, subscribe }
  }

  it('takes no frames while no commentary runs on a sidecar', () => {
    const { subscribe } = setup()

    expect(subscribe).not.toHaveBeenCalled()
  })

  it('sends each frame as base64 while active', async () => {
    const { active, emit, sent } = setup()
    active.value = true
    await nextTick()

    emit([0xFF, 0xD8, 0xFF])
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    expect(Array.from(decodeBase64(sent[0]))).toEqual([0xFF, 0xD8, 0xFF])
  })

  it('drops a frame that comes while the last one is in work', async () => {
    const { emit, sent } = setup(true)

    emit([1])
    emit([2])
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(sent).toHaveLength(1)
  })

  it('stops the frames when the commentary ends, and when its scope ends', async () => {
    const { active, listeners, scope } = setup(true)
    expect(listeners.size).toBe(1)

    active.value = false
    await nextTick()
    expect(listeners.size).toBe(0)

    active.value = true
    await nextTick()
    expect(listeners.size).toBe(1)

    scope.stop()
    expect(listeners.size).toBe(0)
  })

  it('sends no frame that arrives after the end of the commentary', async () => {
    const { active, emit, sent } = setup(true)
    emit([1])
    active.value = false
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(sent).toHaveLength(0)
  })
})
