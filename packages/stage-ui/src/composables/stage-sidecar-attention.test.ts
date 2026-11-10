import type { CharacterAttentionTarget } from '@proj-airi/stage-shared/stage-sidecar'

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

import { useStageSidecarAttention } from './stage-sidecar-attention'

describe('useStageSidecarAttention', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(initiallyActive = true) {
    const active = ref(initiallyActive)
    const engaged = ref(false)
    const sent: CharacterAttentionTarget[] = []
    const scope = effectScope()
    onTestFinished(() => scope.stop())
    scope.run(() => useStageSidecarAttention({
      active,
      isEngaged: () => engaged.value,
      send: target => sent.push(target),
    }))

    return { active, engaged, scope, sent }
  }

  it('turns to the viewer when AIRI starts to think or speak', async () => {
    const { engaged, sent } = setup()

    engaged.value = true
    await nextTick()

    expect(sent).toEqual(['viewer'])
  })

  it('releases the viewer 15 seconds after AIRI stops', async () => {
    const { engaged, sent } = setup()
    engaged.value = true
    await nextTick()

    engaged.value = false
    await nextTick()
    vi.advanceTimersByTime(14_999)

    expect(sent).toEqual(['viewer'])

    vi.advanceTimersByTime(1)

    expect(sent).toEqual(['viewer', 'none'])
  })

  it('keeps the viewer when AIRI speaks again within 15 seconds', async () => {
    const { engaged, sent } = setup()
    engaged.value = true
    await nextTick()
    engaged.value = false
    await nextTick()
    vi.advanceTimersByTime(10_000)

    engaged.value = true
    await nextTick()
    vi.advanceTimersByTime(20_000)

    expect(sent).toEqual(['viewer'])
  })

  it('sends nothing while no sidecar draws the character', async () => {
    const { engaged, sent } = setup(false)

    engaged.value = true
    await nextTick()
    engaged.value = false
    await nextTick()
    vi.advanceTimersByTime(20_000)

    expect(sent).toEqual([])
  })

  it('turns to the viewer when a sidecar starts to draw during a thought', async () => {
    const { active, engaged, sent } = setup(false)
    engaged.value = true
    await nextTick()

    active.value = true
    await nextTick()

    expect(sent).toEqual(['viewer'])
  })

  it('sends no release after its scope ends', async () => {
    const { engaged, scope, sent } = setup()
    engaged.value = true
    await nextTick()
    engaged.value = false
    await nextTick()

    scope.stop()
    vi.advanceTimersByTime(20_000)

    expect(sent).toEqual(['viewer'])
  })
})
