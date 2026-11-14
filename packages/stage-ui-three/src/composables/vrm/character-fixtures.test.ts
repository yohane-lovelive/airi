import type { VRMCore } from '@pixiv/three-vrm-core'

import { fixtureText } from '@proj-airi/stage-shared/stage-sidecar/fixture-text'
import { describe, expect, it } from 'vitest'

import { useVRMEmote } from './expression'

const FIXTURES = '../../../../stage-shared/src/stage-sidecar/character-fixtures'

/** The expressions that the emotion states own. A model can have fewer of them. */
const OWNED = ['happy', 'aa', 'sad', 'oh', 'angry', 'ee', 'surprised', 'neutral', 'think', 'relaxed']
const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh']

function createVrm() {
  const values = new Map<string, number>()
  const expressionMap = Object.fromEntries([...OWNED, ...VISEMES, 'blink'].map(name => [name, {}]))
  const vrm = {
    expressionManager: {
      expressionMap,
      getValue: (name: string) => values.get(name) ?? 0,
      setValue: (name: string, value: number) => void values.set(name, value),
    },
  } as unknown as VRMCore
  return { vrm, values }
}

function timeline() {
  const { vrm, values } = createVrm()
  const emote = useVRMEmote(vrm)
  const steps: Array<Record<string, unknown>> = []
  const snapshot = () => Object.fromEntries(OWNED.map(name => [name, values.get(name) ?? 0]))

  const update = (delta: number, mouthBusy = false) => {
    // Lip sync runs first in the frame of `VRMModel.vue`. While it owns the mouth, it writes the visemes.
    if (mouthBusy) {
      for (const name of VISEMES)
        values.set(name, 0)
    }
    emote.update(delta, { skipVisemes: mouthBusy })
    steps.push({ update: delta, mouthBusy, weights: snapshot(), eyeAreaActive: emote.isEmoteActive.value })
  }
  const set = (name: string, intensity: number) => {
    emote.setEmotion(name, intensity)
    steps.push({ set: name, intensity })
  }

  for (const [name, intensity] of [
    ['happy', 1],
    ['sad', 0.5],
    ['surprised', 1],
    ['think', 0.8],
    ['relaxed', 1],
    ['angry', 1],
    ['neutral', 1],
  ] as const) {
    set(name, intensity)
    for (const delta of [0.05, 0.1, 0.1, 1])
      update(delta)
  }

  // The mouth: an emotion yields its visemes to lip sync, and blends them back when the speech ends.
  set('happy', 1)
  for (const delta of [0.1, 0.5])
    update(delta)
  for (const delta of [0.1, 0.1])
    update(delta, true)
  for (const delta of [0.1, 0.1, 0.1, 0.5])
    update(delta)

  return steps
}

describe('the fixtures of the C# tests of the Unity sidecar', () => {
  it('records the emotions of VRM models', async () => {
    await expect(fixtureText({ owned: OWNED, timeline: timeline() })).toMatchFileSnapshot(`${FIXTURES}/vrm.json`)
  })
})
