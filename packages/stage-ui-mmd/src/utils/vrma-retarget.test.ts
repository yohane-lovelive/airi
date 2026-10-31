import type { MMDRig, VRMAnimationSource } from './vrma-retarget'

import { AnimationMixer, Bone, BufferGeometry, Quaternion, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Vector3, VectorKeyframeTrack } from 'three'
import { describe, expect, it } from 'vitest'

import { mmdRigFromMesh, retargetVRMAnimationToMMD } from './vrma-retarget'

/**
 * A small MMD rig that faces +Z with the character's left at +X, as three-mmd loads it.
 * The left arm rests 45 degrees down, as in an A-pose. `上半身2` is missing on purpose.
 */
const BONES: Array<[name: string, parent: string | undefined, position: [number, number, number]]> = [
  ['全ての親', undefined, [0, 0, 0]],
  ['センター', '全ての親', [0, 8, 0]],
  ['上半身', 'センター', [0, 10, 0]],
  ['首', '上半身', [0, 14, 0]],
  ['頭', '首', [0, 15, 0]],
  ['下半身', 'センター', [0, 10, 0]],
  ['左足', '下半身', [1, 9, 0]],
  ['左ひざ', '左足', [1, 5, 0]],
  ['左足首', '左ひざ', [1, 1, 0]],
  ['左つま先', '左足首', [1, 0, 1]],
  ['左肩', '上半身', [0.5, 13, 0]],
  ['左腕', '左肩', [1.5, 13, 0]],
  ['左ひじ', '左腕', [1.5 + 2 * Math.SQRT1_2, 13 - 2 * Math.SQRT1_2, 0]],
  ['左手首', '左ひじ', [1.5 + 4 * Math.SQRT1_2, 13 - 4 * Math.SQRT1_2, 0]],
  ['左足ＩＫ', '全ての親', [1, 1, 0]],
  ['左つま先ＩＫ', '左足ＩＫ', [1, 0, 1]],
]

function createMesh() {
  const byName = new Map<string, Bone>()
  const bones = BONES.map(([name, parent, position]) => {
    const bone = new Bone()
    bone.name = name
    const parentPosition = parent ? BONES.find(entry => entry[0] === parent)![2] : [0, 0, 0]
    bone.position.set(position[0] - parentPosition[0], position[1] - parentPosition[1], position[2] - parentPosition[2])
    if (parent)
      byName.get(parent)!.add(bone)
    byName.set(name, bone)
    return bone
  })
  const mesh = new SkinnedMesh(new BufferGeometry())
  mesh.add(bones[0])
  mesh.bind(new Skeleton(bones))
  const index = (name: string) => bones.findIndex(bone => bone.name === name)
  const ikEffectors = new Map([[index('左足ＩＫ'), index('左足首')], [index('左つま先ＩＫ'), index('左つま先')]])
  return { mesh, byName, rig: mmdRigFromMesh(mesh, ikEffectors) }
}

function animationOf(rotations: Record<string, Quaternion> = {}, hipsY?: number): VRMAnimationSource {
  return {
    duration: 1,
    restHipsPosition: new Vector3(0, 1, 0),
    humanoidTracks: {
      rotation: new Map(Object.entries(rotations).map(([name, rotation]) => [
        name as never,
        new QuaternionKeyframeTrack(`${name}.quaternion`, [0, 1], [...rotation.toArray(), ...rotation.toArray()]),
      ])),
      translation: new Map(hipsY === undefined ? [] : [['hips', new VectorKeyframeTrack('hips.position', [0, 1], [0, hipsY, 0, 0, hipsY, 0])]]),
    },
  }
}

/** Poses the mesh with the first frame of a retargeted clip, then returns world positions by bone name. */
function pose(animation: VRMAnimationSource) {
  const { mesh, byName, rig } = createMesh()
  const mixer = new AnimationMixer(mesh)
  mixer.clipAction(retargetVRMAnimationToMMD(animation, rig as MMDRig)).play()
  mixer.update(0)
  mesh.updateMatrixWorld(true)
  return (name: string) => byName.get(name)!.getWorldPosition(new Vector3())
}

function direction(at: (name: string) => Vector3, from: string, to: string) {
  return at(to).sub(at(from)).normalize()
}

const aboutZ = (degrees: number) => new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), degrees * Math.PI / 180)
const aboutX = (degrees: number) => new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), degrees * Math.PI / 180)

describe('mmdRigFromMesh', () => {
  it('reads rest positions in model space and the IK pairs', () => {
    const { rig } = createMesh()

    expect(rig.bones.find(bone => bone.name === '左ひざ')!.restPosition.toArray()).toEqual([1, 5, 0])
    expect(rig.iks).toHaveLength(2)
  })
})

describe('retargetVRMAnimationToMMD', () => {
  it('raises an A-pose arm to the side for the VRM T-pose', () => {
    const at = pose(animationOf())

    expect(direction(at, '左腕', '左ひじ').distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-6)
  })

  it('gives the MMD arm the world direction of the VRM arm', () => {
    const at = pose(animationOf({ leftUpperArm: aboutZ(-45) }))

    const expected = new Vector3(1, 0, 0).applyQuaternion(aboutZ(-45))
    expect(direction(at, '左腕', '左ひじ').distanceTo(expected)).toBeLessThan(1e-6)
  })

  it('passes a rotation of a bone that the model lacks to its children', () => {
    // The model has no `上半身2`, so the chest rotation reaches `首` through the world rotation.
    const at = pose(animationOf({ chest: aboutX(30) }))

    const expected = new Vector3(0, 1, 0).applyQuaternion(aboutX(30))
    expect(direction(at, '首', '頭').distanceTo(expected)).toBeLessThan(1e-6)
  })

  it('moves センター by the hips translation, scaled by the hip heights', () => {
    // The VRM hips rest at 1 and the MMD hips at 9, so 0.1 down becomes 0.9 down.
    const at = pose(animationOf({}, 0.9))

    expect(at('センター').y).toBeCloseTo(7.1)
  })

  it('moves the IK bones to their effectors, so IK can stay on', () => {
    const at = pose(animationOf({ leftUpperLeg: aboutX(-40), leftLowerLeg: aboutX(70) }, 0.9))

    expect(at('左足ＩＫ').distanceTo(at('左足首'))).toBeLessThan(1e-6)
    expect(at('左つま先ＩＫ').distanceTo(at('左つま先'))).toBeLessThan(1e-6)
    // The knee bend moved the ankle away from its rest position.
    expect(at('左足首').distanceTo(new Vector3(1, 1, 0))).toBeGreaterThan(0.5)
  })

  it('writes tracks that only target bones of the model', () => {
    const { rig } = createMesh()

    const clip = retargetVRMAnimationToMMD(animationOf({ leftUpperArm: aboutZ(-45), rightUpperArm: aboutZ(45) }), rig)

    const names = clip.tracks.map(track => track.name)
    expect(names).toContain('.bones[左腕].quaternion')
    expect(names).toContain('.bones[左足ＩＫ].position')
    expect(names.some(name => name.includes('右'))).toBe(false)
  })
})
