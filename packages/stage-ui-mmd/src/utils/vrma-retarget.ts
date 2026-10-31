import type { VRMAnimation } from '@pixiv/three-vrm-animation'
import type { VRMHumanBoneName } from '@pixiv/three-vrm-core'
import type { KeyframeTrack, SkinnedMesh } from 'three'

import { AnimationClip, LinearInterpolant, Quaternion, QuaternionKeyframeTrack, QuaternionLinearInterpolant, Vector3, VectorKeyframeTrack } from 'three'

/** The parts of a VRM Animation that the retarget reads. */
export type VRMAnimationSource = Pick<VRMAnimation, 'duration' | 'restHipsPosition' | 'humanoidTracks'>

/** One bone of an MMD model at rest. MMD bones rest without rotation, so a position describes the rest pose. */
export interface MMDRigBone {
  name: string
  /** Index of the parent bone, or -1 for a root. */
  parent: number
  /** Rest position in model space. */
  restPosition: Vector3
}

/** An MMD IK bone and the bone that its solver moves to it, for example `左足ＩＫ` and `左足首`. */
export interface MMDRigIK {
  bone: number
  effector: number
  /** The bones that the solver rotates, for example `左ひざ` and `左足`. */
  links: number[]
}

export interface MMDRig {
  bones: MMDRigBone[]
  iks: MMDRigIK[]
}

export interface RetargetOptions {
  /** @default 30, the frame rate of MMD motions */
  fps?: number
  /** @default 'vrma' */
  name?: string
}

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const
const FINGER_JOINTS: Record<(typeof FINGERS)[number], readonly string[]> = {
  Thumb: ['Metacarpal', 'Proximal', 'Distal'],
  Index: ['Proximal', 'Intermediate', 'Distal'],
  Middle: ['Proximal', 'Intermediate', 'Distal'],
  Ring: ['Proximal', 'Intermediate', 'Distal'],
  Little: ['Proximal', 'Intermediate', 'Distal'],
}
const MMD_FINGER: Record<(typeof FINGERS)[number], { name: string, first: number }> = {
  Thumb: { name: '親指', first: 0 },
  Index: { name: '人指', first: 1 },
  Middle: { name: '中指', first: 1 },
  Ring: { name: '薬指', first: 1 },
  Little: { name: '小指', first: 1 },
}
const FULL_WIDTH_DIGITS = '０１２３'

interface HumanBoneSpec {
  /** The VRM parent bone. A bone without a track keeps its rest rotation, so optional parents are listed too. */
  parent?: VRMHumanBoneName
  /** Standard MMD bone names, first match wins. */
  mmd: string[]
  /** The bone whose rest position gives this bone's direction, for the rest pose correction. */
  next?: VRMHumanBoneName
  /** The direction of the bone in the VRM T-pose: arms point to the side, fingers follow the arm. */
  tPose?: Vector3
}

/**
 * VRM humanoid bones and their standard MMD bones.
 *
 * The hips drive `センター`, so `上半身` and `下半身` follow it. The eyes stay out, because the gaze controller owns them.
 */
function buildHumanBones(): Map<VRMHumanBoneName, HumanBoneSpec> {
  const bones = new Map<VRMHumanBoneName, HumanBoneSpec>([
    ['hips', { mmd: ['センター'] }],
    ['spine', { parent: 'hips', mmd: ['上半身'] }],
    ['chest', { parent: 'spine', mmd: ['上半身2'] }],
    ['upperChest', { parent: 'chest', mmd: ['上半身3'] }],
    ['neck', { parent: 'upperChest', mmd: ['首'] }],
    ['head', { parent: 'neck', mmd: ['頭'] }],
  ])

  for (const [side, mmd, x] of [['left', '左', 1], ['right', '右', -1]] as const) {
    const bone = (name: string) => `${side}${name}` as VRMHumanBoneName
    const out = new Vector3(x, 0, 0)
    bones.set(bone('Shoulder'), { parent: 'upperChest', mmd: [`${mmd}肩`], next: bone('UpperArm'), tPose: out })
    bones.set(bone('UpperArm'), { parent: bone('Shoulder'), mmd: [`${mmd}腕`], next: bone('LowerArm'), tPose: out })
    bones.set(bone('LowerArm'), { parent: bone('UpperArm'), mmd: [`${mmd}ひじ`], next: bone('Hand'), tPose: out })
    bones.set(bone('Hand'), { parent: bone('LowerArm'), mmd: [`${mmd}手首`], next: bone('MiddleProximal'), tPose: out })
    bones.set(bone('UpperLeg'), { parent: 'hips', mmd: [`${mmd}足`] })
    bones.set(bone('LowerLeg'), { parent: bone('UpperLeg'), mmd: [`${mmd}ひざ`] })
    bones.set(bone('Foot'), { parent: bone('LowerLeg'), mmd: [`${mmd}足首`] })
    bones.set(bone('Toes'), { parent: bone('Foot'), mmd: [`${mmd}つま先`] })

    for (const finger of FINGERS) {
      const joints = FINGER_JOINTS[finger]
      joints.forEach((joint, index) => {
        const name = bone(`${finger}${joint}`)
        const mmdName = `${mmd}${MMD_FINGER[finger].name}${FULL_WIDTH_DIGITS[MMD_FINGER[finger].first + index]}`
        const parent = index === 0 ? bone('Hand') : bone(`${finger}${joints[index - 1]}`)
        const next = index < joints.length - 1 ? bone(`${finger}${joints[index + 1]}`) : undefined
        // The thumb points forward in a T-pose, so it keeps the hand correction instead of its own.
        bones.set(name, { parent, mmd: [mmdName], next: finger === 'Thumb' ? undefined : next, tPose: finger === 'Thumb' ? undefined : out })
      })
    }
  }
  return bones
}

const HUMAN_BONES = buildHumanBones()

/** VRM bones in parent-first order. */
const HUMAN_BONE_ORDER: VRMHumanBoneName[] = (() => {
  const order: VRMHumanBoneName[] = []
  const visit = (name: VRMHumanBoneName) => {
    if (order.includes(name))
      return
    const parent = HUMAN_BONES.get(name)?.parent
    if (parent)
      visit(parent)
    order.push(name)
  }
  for (const name of HUMAN_BONES.keys())
    visit(name)
  return order
})()

/**
 * Reads the rig of a loaded MMD model. Call it before any motion plays, while the bones are at rest.
 *
 * `iks` lists the IK bones by index, as `MMD.pmx.bones[i].ik` gives them: the effector `target` and the `links`.
 */
export function mmdRigFromMesh(mesh: SkinnedMesh, iks: readonly MMDRigIK[]): MMDRig {
  const skeletonBones = mesh.skeleton.bones
  const indexOf = new Map(skeletonBones.map((bone, index) => [bone, index]))
  const bones: MMDRigBone[] = skeletonBones.map(bone => ({
    name: bone.name,
    parent: (bone.parent && indexOf.get(bone.parent as typeof bone)) ?? -1,
    restPosition: bone.position.clone(),
  }))
  // Rest rotations are identity, so a rest position is the sum of the local positions up the chain.
  for (const index of parentFirstOrder(bones)) {
    const parent = bones[index].parent
    if (parent !== -1)
      bones[index].restPosition.add(bones[parent].restPosition)
  }
  return { bones, iks: iks.map(ik => ({ ...ik, links: [...ik.links] })) }
}

/** Bone indices in parent-first order, so a parent's transform is known before its children need it. */
function parentFirstOrder(bones: readonly MMDRigBone[]): number[] {
  const order: number[] = []
  const visited = new Set<number>()
  const visit = (index: number) => {
    if (visited.has(index))
      return
    visited.add(index)
    const parent = bones[index].parent
    if (parent !== -1)
      visit(parent)
    order.push(index)
  }
  bones.forEach((_, index) => visit(index))
  return order
}

/** Samples a track at any time, with spherical interpolation for rotations. */
function sampler(track: KeyframeTrack | undefined) {
  if (!track)
    return undefined
  const interpolant = track instanceof QuaternionKeyframeTrack
    ? new QuaternionLinearInterpolant(track.times, track.values, 4)
    : new LinearInterpolant(track.times, track.values, track.getValueSize())
  return (time: number) => interpolant.evaluate(time)
}

/**
 * Retargets a VRM Animation to an MMD model.
 *
 * - Each VRM bone rotation is relative to the VRM T-pose. Code turns it into a world rotation and gives the MMD bone the
 *   same world rotation, corrected for the MMD rest pose. MMD models rest in an A-pose, so the arms differ most.
 * - The hips motion from the first frame moves `センター`, scaled by the ratio of hip heights.
 * - IK bones that rotate retargeted bones, for example `左足ＩＫ`, follow the position of their effector in the
 *   retargeted pose. IK can stay on, so the clip blends with VMD motions that drive the legs by IK.
 * - Other IK bones keep their place under their parent. Helper IK such as `左腕WIK` under `左ひじ` turns a helper bone
 *   toward the elbow, so it must follow the arm.
 *
 * @returns A clip with tracks named like VMD clips, `.bones[name].quaternion` and `.bones[name].position`.
 */
export function retargetVRMAnimationToMMD(animation: VRMAnimationSource, rig: MMDRig, options: RetargetOptions = {}): AnimationClip {
  const fps = options.fps ?? 30
  const boneIndex = new Map(rig.bones.map((bone, index) => [bone.name, index]))
  const targetOf = new Map<VRMHumanBoneName, number>()
  for (const [name, spec] of HUMAN_BONES) {
    const index = spec.mmd.map(candidate => boneIndex.get(candidate)).find(found => found !== undefined)
    if (index !== undefined)
      targetOf.set(name, index)
  }
  const humanOf = new Map([...targetOf].map(([human, index]) => [index, human]))

  // Rest correction: the rotation that turns the MMD rest direction of a bone into its T-pose direction.
  const correction = new Map<VRMHumanBoneName, Quaternion>()
  for (const name of HUMAN_BONE_ORDER) {
    const spec = HUMAN_BONES.get(name)!
    const own = targetOf.get(name)
    const next = spec.next ? targetOf.get(spec.next) : undefined
    if (spec.tPose && own !== undefined && next !== undefined) {
      const rest = rig.bones[next].restPosition.clone().sub(rig.bones[own].restPosition)
      if (rest.lengthSq() > 1e-8) {
        correction.set(name, new Quaternion().setFromUnitVectors(rest.normalize(), spec.tPose))
        continue
      }
    }
    // A bone without its own direction, for example a hand without a middle finger, keeps its parent's correction.
    correction.set(name, (spec.parent && correction.get(spec.parent)?.clone()) || new Quaternion())
  }

  const rotationOf = new Map([...animation.humanoidTracks.rotation].map(([name, track]) => [name, sampler(track)]))
  const hipsTranslation = sampler(animation.humanoidTracks.translation.get('hips'))
  // A clip can start away from its rest hips, for example to the side. The VRM scene anchors the first frame at the rest
  // hips, so the motion is relative to the first frame here too.
  const hipsStart = hipsTranslation ? new Vector3().fromArray(hipsTranslation(0)) : animation.restHipsPosition
  const hipsIndex = targetOf.get('hips')
  const legs = ['左足', '右足'].map(name => boneIndex.get(name)).filter(index => index !== undefined)
  const mmdHipHeight = legs.length
    ? legs.reduce((sum, index) => sum + rig.bones[index].restPosition.y, 0) / legs.length
    : (hipsIndex !== undefined ? rig.bones[hipsIndex].restPosition.y : 0)
  const hipScale = animation.restHipsPosition.y > 0 ? mmdHipHeight / animation.restHipsPosition.y : 0

  const order = parentFirstOrder(rig.bones)
  // Only IK that rotates a retargeted bone moves. Helper IK, for example `左腕WIK` under `左ひじ`, follows its parent.
  const ikBones = new Map(rig.iks
    .filter(ik => ik.links.some(link => humanOf.has(link)))
    .map(ik => [ik.bone, ik.effector]))

  const frameCount = Math.max(1, Math.round(animation.duration * fps) + 1)
  const times = Array.from({ length: frameCount }, (_, frame) => Math.min(frame / fps, animation.duration))
  const rotations = new Map<number, number[]>()
  const positions = new Map<number, number[]>()
  for (const index of targetOf.values())
    rotations.set(index, [])
  if (hipsIndex !== undefined)
    positions.set(hipsIndex, [])
  for (const index of ikBones.keys())
    positions.set(index, [])

  const vrmWorld = new Map<VRMHumanBoneName, Quaternion>()
  const mmdWorld = new Map<number, Quaternion>()
  const local = new Quaternion()
  const worldRotation = rig.bones.map(() => new Quaternion())
  const worldPosition = rig.bones.map(() => new Vector3())
  const localPosition = new Vector3()

  for (const time of times) {
    // 1. VRM world rotations. Normalized VRM bones rest with identity rotation, so a world rotation is a product of locals.
    for (const name of HUMAN_BONE_ORDER) {
      const values = rotationOf.get(name)?.(time)
      const own = values ? new Quaternion().fromArray(values) : new Quaternion()
      const parent = HUMAN_BONES.get(name)!.parent
      vrmWorld.set(name, parent ? vrmWorld.get(parent)!.clone().multiply(own) : own)
    }

    // 2. MMD world rotations of the mapped bones, corrected for the MMD rest pose.
    mmdWorld.clear()
    for (const [name, index] of targetOf)
      mmdWorld.set(index, vrmWorld.get(name)!.clone().multiply(correction.get(name)!))

    // 3. MMD local rotations, relative to the nearest mapped ancestor. Unmapped bones keep their rest rotation.
    for (const index of order) {
      const parent = rig.bones[index].parent
      const parentWorld = parent === -1 ? new Quaternion() : worldRotation[parent]
      const human = humanOf.get(index)
      if (human) {
        local.copy(parentWorld).invert().multiply(mmdWorld.get(index)!)
        rotations.get(index)!.push(local.x, local.y, local.z, local.w)
      }
      else {
        local.identity()
      }
      worldRotation[index].copy(parentWorld).multiply(local)

      // Forward kinematics on the MMD rest offsets gives the effector positions for the IK bones.
      localPosition.copy(rig.bones[index].restPosition)
      if (parent !== -1)
        localPosition.sub(rig.bones[parent].restPosition)
      if (index === hipsIndex) {
        const hips = hipsTranslation?.(time)
        if (hips)
          localPosition.add(new Vector3(hips[0], hips[1], hips[2]).sub(hipsStart).multiplyScalar(hipScale))
        positions.get(index)!.push(localPosition.x, localPosition.y, localPosition.z)
      }
      worldPosition[index].copy(localPosition).applyQuaternion(parent === -1 ? new Quaternion() : worldRotation[parent])
      if (parent !== -1)
        worldPosition[index].add(worldPosition[parent])
    }

    // 4. IK bones move to their effectors. IK bones sit outside the leg chains, so their effectors are known here.
    for (const index of order) {
      const effector = ikBones.get(index)
      if (effector === undefined)
        continue
      const parent = rig.bones[index].parent
      const parentRotation = parent === -1 ? new Quaternion() : worldRotation[parent]
      const parentPosition = parent === -1 ? new Vector3() : worldPosition[parent]
      localPosition.copy(worldPosition[effector]).sub(parentPosition).applyQuaternion(parentRotation.clone().invert())
      positions.get(index)!.push(localPosition.x, localPosition.y, localPosition.z)
      worldPosition[index].copy(worldPosition[effector])
    }
  }

  const tracks: KeyframeTrack[] = []
  for (const [index, values] of rotations)
    tracks.push(new QuaternionKeyframeTrack(`.bones[${rig.bones[index].name}].quaternion`, times, values))
  for (const [index, values] of positions)
    tracks.push(new VectorKeyframeTrack(`.bones[${rig.bones[index].name}].position`, times, values))
  return new AnimationClip(options.name ?? 'vrma', animation.duration, tracks)
}
