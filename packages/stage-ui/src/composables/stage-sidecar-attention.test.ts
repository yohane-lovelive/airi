import type { CharacterActivity, CharacterAttentionTarget } from '@proj-airi/stage-shared/stage-sidecar'

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
    const thinking = ref(false)
    const speaking = ref(false)
    const commenting = ref(false)
    const sent: CharacterAttentionTarget[] = []
    const activities: CharacterActivity[] = []
    const scope = effectScope()
    onTestFinished(() => scope.stop())
    scope.run(() => useStageSidecarAttention({
      active,
      isThinking: () => thinking.value,
      isSpeaking: () => speaking.value,
      isCommenting: () => commenting.value,
      send: target => sent.push(target),
      sendActivity: activity => activities.push(activity),
    }))

    return { active, activities, commenting, scope, sent, speaking, thinking }
  }

  it('turns to the viewer when AIRI starts to think or speak', async () => {
    const { sent, speaking, thinking } = setup()

    thinking.value = true
    await nextTick()
    thinking.value = false
    speaking.value = true
    await nextTick()

    expect(sent).toEqual(['viewer'])
  })

  it('releases the viewer 15 seconds after AIRI stops', async () => {
    const { sent, speaking } = setup()
    speaking.value = true
    await nextTick()

    speaking.value = false
    await nextTick()
    vi.advanceTimersByTime(14_999)

    expect(sent).toEqual(['viewer'])

    vi.advanceTimersByTime(1)

    expect(sent).toEqual(['viewer', 'none'])
  })

  it('keeps the viewer when AIRI speaks again within 15 seconds', async () => {
    const { sent, speaking } = setup()
    speaking.value = true
    await nextTick()
    speaking.value = false
    await nextTick()
    vi.advanceTimersByTime(10_000)

    speaking.value = true
    await nextTick()
    vi.advanceTimersByTime(20_000)

    expect(sent).toEqual(['viewer'])
  })

  it('sends nothing while no sidecar draws the character', async () => {
    const { activities, commenting, sent, speaking } = setup(false)

    speaking.value = true
    commenting.value = true
    await nextTick()
    speaking.value = false
    commenting.value = false
    await nextTick()
    vi.advanceTimersByTime(20_000)

    expect(sent).toEqual([])
    expect(activities).toEqual([])
  })

  it('turns to the viewer when a sidecar starts to draw during a thought', async () => {
    const { active, sent, thinking } = setup(false)
    thinking.value = true
    await nextTick()

    active.value = true
    await nextTick()

    expect(sent).toEqual(['viewer'])
  })

  it('sends no release after its scope ends', async () => {
    const { scope, sent, speaking } = setup()
    speaking.value = true
    await nextTick()
    speaking.value = false
    await nextTick()

    scope.stop()
    vi.advanceTimersByTime(20_000)

    expect(sent).toEqual(['viewer'])
  })

  describe('during a commentary', () => {
    it('sends the activity when a commentary starts and ends', async () => {
      const { activities, commenting } = setup()

      commenting.value = true
      await nextTick()
      commenting.value = false
      await nextTick()

      expect(activities).toEqual(['watching-screen', 'none'])
    })

    it('sends the activity when a sidecar starts to draw during a commentary', async () => {
      const { activities, active, commenting } = setup(false)
      commenting.value = true
      await nextTick()

      active.value = true
      await nextTick()

      expect(activities).toEqual(['watching-screen'])
    })

    it('does not turn to the viewer for a thought', async () => {
      const { commenting, sent, thinking } = setup()
      commenting.value = true
      await nextTick()

      thinking.value = true
      await nextTick()

      expect(sent).toEqual([])
    })

    it('turns to the viewer for a line, and releases her 2 seconds after it', async () => {
      const { commenting, sent, speaking } = setup()
      commenting.value = true
      await nextTick()

      speaking.value = true
      await nextTick()
      speaking.value = false
      await nextTick()
      vi.advanceTimersByTime(1_999)

      expect(sent).toEqual(['viewer'])

      vi.advanceTimersByTime(1)

      expect(sent).toEqual(['viewer', 'none'])
    })

    it('shortens a release of 15 seconds when a commentary starts', async () => {
      const { commenting, sent, speaking } = setup()
      speaking.value = true
      await nextTick()
      speaking.value = false
      await nextTick()
      vi.advanceTimersByTime(5_000)

      commenting.value = true
      await nextTick()
      vi.advanceTimersByTime(2_000)

      expect(sent).toEqual(['viewer', 'none'])
    })

    it('releases a thought that was in progress when the commentary starts', async () => {
      const { commenting, sent, thinking } = setup()
      thinking.value = true
      await nextTick()

      commenting.value = true
      await nextTick()
      vi.advanceTimersByTime(2_000)

      expect(sent).toEqual(['viewer', 'none'])
    })
  })
})
