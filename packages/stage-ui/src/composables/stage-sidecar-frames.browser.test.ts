import type { CharacterFrame } from '@proj-airi/stage-shared/stage-sidecar'

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

import { useStageSidecarFrames } from './stage-sidecar-frames'

function peakOf(mouth: CharacterFrame['mouth']) {
  return Math.max(mouth.A, mouth.E, mouth.I, mouth.O, mouth.U)
}

describe('useStageSidecarFrames', () => {
  let contexts: AudioContext[] = []

  afterEach(async () => {
    await Promise.all(contexts.map(context => context.close()))
    contexts = []
  })

  /** A real audio graph. The tone goes only to the analysis, so nothing plays. */
  async function setup(speaking = true) {
    const context = new AudioContext()
    contexts.push(context)
    await context.resume()

    const speechSource = context.createGain()
    const isSpeaking = ref(speaking)
    const active = ref(true)
    const frames: CharacterFrame[] = []
    const scope = effectScope()
    onTestFinished(() => scope.stop())
    scope.run(() => useStageSidecarFrames({
      active,
      audioContext: context,
      speechSource,
      isSpeaking: () => isSpeaking.value,
      isThinking: () => false,
      isBodyMotionEnabled: () => false,
      send: frame => frames.push(frame),
    }))

    function startTone() {
      const oscillator = context.createOscillator()
      oscillator.type = 'sawtooth'
      oscillator.frequency.value = 180
      const filter = context.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = 800
      const gain = context.createGain()
      gain.gain.value = 1.5
      oscillator.connect(filter).connect(gain).connect(speechSource)
      oscillator.start()
      return () => {
        oscillator.stop()
        oscillator.disconnect()
      }
    }

    return { active, frames, isSpeaking, startTone }
  }

  it('opens the mouth during speech', async () => {
    const { frames, startTone } = await setup()

    const stopTone = startTone()
    onTestFinished(stopTone)

    await vi.waitFor(() => expect(peakOf(frames.at(-1)!.mouth)).toBeGreaterThan(0.1), { timeout: 5000 })
  })

  // Found in the live check of step U1: the mouth stayed at A = 0.49 after the speech ended.
  //
  // ROOT CAUSE:
  //
  // The lip sync node keeps its last volume and weights when its input has no audio. The frames continue, so the
  // deadline of the sidecar does not close the mouth either.
  //
  // We fixed this like the Live2D path in `Stage.vue`: the mouth follows the node only while the character speaks.
  it('closes the mouth when the speech ends, although the node keeps its last values', async () => {
    const { frames, isSpeaking, startTone } = await setup()
    const stopTone = startTone()
    await vi.waitFor(() => expect(peakOf(frames.at(-1)!.mouth)).toBeGreaterThan(0.1), { timeout: 5000 })

    stopTone()
    isSpeaking.value = false

    await vi.waitFor(() => expect(peakOf(frames.at(-1)!.mouth)).toBe(0), { timeout: 3000 })
  })

  it('keeps the mouth closed for audio that is not the speech of the character', async () => {
    const { frames, startTone } = await setup(false)
    const stopTone = startTone()
    onTestFinished(stopTone)

    await new Promise(resolve => setTimeout(resolve, 500))

    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every(frame => peakOf(frame.mouth) === 0)).toBe(true)
  })

  it('sends no frames while it is not active', async () => {
    const { active, frames } = await setup()
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0))

    active.value = false
    await nextTick()
    const count = frames.length
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(frames).toHaveLength(count)
  })
})
