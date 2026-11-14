import type { VRMHumanBoneName } from '@pixiv/three-vrm-core'

import type { MorphSlot } from '../../constants/morphs'
import type { MMDRig, VRMAnimationSource } from '../../utils/vrma-retarget'
import type { MorphController } from './morph'

import { VRMHumanBoneList } from '@pixiv/three-vrm-core'
import { BUILT_IN_GESTURES, gestureGroupOfHumanBone } from '@proj-airi/stage-shared/body-motion'
import { fixtureText } from '@proj-airi/stage-shared/stage-sidecar/fixture-text'
import { Quaternion, QuaternionKeyframeTrack, QuaternionLinearInterpolant, Vector3, VectorKeyframeTrack } from 'three'
import { describe, expect, it } from 'vitest'

import { Emotion } from '../../constants/emotions'
import { EMOTION_MORPHS, MORPH_CANDIDATES } from '../../constants/morphs'
import { vrmAnimationOfGesture } from '../../utils/mmd-gestures'
import { mmdBoneNamesOfHumanBone, retargetVRMAnimationToMMD } from '../../utils/vrma-retarget'
import { useMMDEmote } from './expression'

const FIXTURES = '../../../../stage-shared/src/stage-sidecar/character-fixtures'

/** One side of a rig that rests in an A-pose, with the arm 45 degrees down. `x` is 1 for the left side. */
function sideBones(mmd: string, x: number): Array<[string, string, [number, number, number]]> {
  const arm = (scale: number): [number, number, number] => [x * (1.5 + 2 * scale * Math.SQRT1_2), 13 - 2 * scale * Math.SQRT1_2, 0]
  const hand = arm(2)
  return [
    [`${mmd}足`, '下半身', [x, 9, 0]],
    [`${mmd}ひざ`, `${mmd}足`, [x, 5, 0.1]],
    [`${mmd}足首`, `${mmd}ひざ`, [x, 1, 0]],
    [`${mmd}つま先`, `${mmd}足首`, [x, 0, 1]],
    [`${mmd}肩`, '上半身2', [x * 0.5, 13.2, 0]],
    [`${mmd}腕`, `${mmd}肩`, [x * 1.5, 13, 0]],
    [`${mmd}ひじ`, `${mmd}腕`, arm(1)],
    // The elbow bends a little at rest, so each bone of the arm has its own correction.
    [`${mmd}手首`, `${mmd}ひじ`, [hand[0] + x * 0.1, hand[1], 0.2]],
    [`${mmd}親指０`, `${mmd}手首`, [hand[0] + x * 0.2, hand[1] - 0.1, 0.5]],
    [`${mmd}親指１`, `${mmd}親指０`, [hand[0] + x * 0.3, hand[1] - 0.2, 0.6]],
    [`${mmd}中指１`, `${mmd}手首`, [hand[0] + x * 0.7, hand[1] - 0.7, 0.2]],
    [`${mmd}中指２`, `${mmd}中指１`, [hand[0] + x * 0.9, hand[1] - 0.9, 0.2]],
    [`${mmd}中指３`, `${mmd}中指２`, [hand[0] + x * 1.1, hand[1] - 1.1, 0.2]],
  ]
}

/** A rig in the frame of three-mmd: it faces +Z, and the left side of the character is at +X. */
const BONES: Array<[string, string | undefined, [number, number, number]]> = [
  ['全ての親', undefined, [0, 0, 0]],
  ['センター', '全ての親', [0, 8, 0]],
  ['上半身', 'センター', [0, 10, 0]],
  ['上半身2', '上半身', [0, 12, 0]],
  ['首', '上半身2', [0, 14, 0]],
  ['頭', '首', [0, 15, 0]],
  ['下半身', 'センター', [0, 10, 0]],
  ['両目', '頭', [0, 16, 0.5]],
  ...sideBones('左', 1),
  ...sideBones('右', -1),
]

const RIG: MMDRig = {
  bones: BONES.map(([name, parent, position]) => ({
    name,
    parent: parent ? BONES.findIndex(bone => bone[0] === parent) : -1,
    restPosition: new Vector3(...position),
  })),
  iks: [],
}

/** A clip with a hips motion that starts away from the rest hips, as a real idle clip does. */
const HIPS_CLIP: VRMAnimationSource = {
  duration: 2,
  restHipsPosition: new Vector3(0, 0.9, 0),
  humanoidTracks: {
    rotation: new Map<VRMHumanBoneName, QuaternionKeyframeTrack>([
      ['hips', new QuaternionKeyframeTrack('hips.quaternion', [0, 2], [...new Quaternion().toArray(), ...new Quaternion(0, 0.1, 0, 0.994987).toArray()])],
      ['leftUpperArm', new QuaternionKeyframeTrack('leftUpperArm.quaternion', [0, 2], [...new Quaternion().toArray(), ...new Quaternion(0, 0, -0.5, 0.866025).toArray()])],
    ]),
    translation: new Map([
      ['hips', new VectorKeyframeTrack('hips.position', [0, 2], [0.1, 0.9, 0, 0.2, 0.85, 0.05])],
    ]),
  } as VRMAnimationSource['humanoidTracks'],
}

function samplerOf(track: QuaternionKeyframeTrack) {
  const interpolant = new QuaternionLinearInterpolant(track.times, track.values, 4)
  return (time: number) => Array.from(interpolant.evaluate(time))
}

function retargetFrames(id: string, animation: VRMAnimationSource, frames: number[]) {
  const clip = retargetVRMAnimationToMMD(animation, RIG, { name: id })
  const samplers = [...animation.humanoidTracks.rotation].map(([bone, track]) => [bone, samplerOf(track as QuaternionKeyframeTrack)] as const)
  const hips = animation.humanoidTracks.translation.get('hips')
  const center = RIG.bones[1].restPosition.clone().sub(RIG.bones[0].restPosition)
  const firstHips = hips ? new Vector3().fromArray(hips.values) : animation.restHipsPosition.clone()

  return {
    id,
    frames: frames.map((frame) => {
      const time = clip.tracks[0].times[frame]
      const rotations: Record<string, number[]> = {}
      for (const track of clip.tracks) {
        const bone = /^\.bones\[(.+)\]\.quaternion$/.exec(track.name)?.[1]
        if (bone)
          rotations[bone] = Array.from(track.values.slice(frame * 4, frame * 4 + 4))
      }
      const centerTrack = clip.tracks.find(track => track.name === '.bones[センター].position')!
      const place = new Vector3().fromArray(centerTrack.values, frame * 3).sub(center)
      const hipsNow = hips ? new Vector3().fromArray(hips.values).lerp(new Vector3().fromArray(hips.values, 3), time / animation.duration) : firstHips.clone()

      return {
        time,
        input: Object.fromEntries(samplers.map(([bone, sample]) => [bone, sample(time)])),
        hips: hipsNow.sub(firstHips).divideScalar(animation.restHipsPosition.y).toArray(),
        rotations,
        centerOffset: place.toArray(),
      }
    }),
  }
}

function createMorphs(): MorphController {
  const values = new Map<MorphSlot, number>()
  return {
    resolvedSlots: [],
    availableMorphs: [],
    set: (slot, weight) => void values.set(slot, weight),
    get: slot => values.get(slot) ?? 0,
    override: () => {},
    resetManaged: () => values.clear(),
  }
}

/** The slots that the emotions own alone. Lip sync writes the vowels each frame, so they stay out of this record. */
const EXPRESSION_SLOTS: MorphSlot[] = ['smile', 'anger', 'sad', 'surprise', 'troubled', 'serious']

function emoteTimeline() {
  const morphs = createMorphs()
  const emote = useMMDEmote(morphs)
  const steps: Array<Record<string, unknown>> = []
  const snapshot = () => Object.fromEntries(EXPRESSION_SLOTS.map(slot => [slot, morphs.get(slot)]))
  const update = (delta: number) => {
    emote.update(delta)
    steps.push({ update: delta, weights: snapshot() })
  }
  const set = (emotion: Emotion, intensity: number) => {
    emote.setEmotion(emotion, intensity)
    steps.push({ set: emotion, intensity })
  }

  for (const [emotion, intensity] of [
    [Emotion.Happy, 1],
    [Emotion.Sad, 0.5],
    [Emotion.Surprise, 1],
    [Emotion.Awkward, 0.8],
    [Emotion.Neutral, 1],
  ] as const) {
    set(emotion, intensity)
    for (const delta of [0.05, 0.1, 0.1, 1])
      update(delta)
  }
  return steps
}

describe('the fixtures of the C# tests of the Unity sidecar', () => {
  it('records the bones, morphs, emotions, and retarget of MMD models', async () => {
    const text = fixtureText({
      humanBones: VRMHumanBoneList
        .filter(bone => mmdBoneNamesOfHumanBone(bone).length > 0)
        .map(bone => ({ name: bone, mmd: mmdBoneNamesOfHumanBone(bone)[0], group: gestureGroupOfHumanBone(bone) ?? null })),
      morphCandidates: MORPH_CANDIDATES,
      emotions: EMOTION_MORPHS,
      emoteTimeline: emoteTimeline(),
      rig: BONES.map(([name, parent, position]) => ({ name, parent: parent ?? null, position })),
      retarget: [
        ...['wave', 'bow', 'shrug', 'fist-pump', 'cross-arms'].map((id) => {
          const gesture = BUILT_IN_GESTURES.find(item => item.id === id)!
          return retargetFrames(id, vrmAnimationOfGesture(gesture), [0, 7, 15, 30])
        }),
        retargetFrames('hips', HIPS_CLIP, [0, 15, 60]),
      ],
    })

    await expect(text).toMatchFileSnapshot(`${FIXTURES}/mmd.json`)
  })
})
