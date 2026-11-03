import type { VRMHumanBoneName } from '@pixiv/three-vrm-core'
import type { GestureDefinition, GestureGroup } from '@proj-airi/stage-shared/body-motion'
import type { AnimationClip } from 'three'

import type { MMDRig, VRMAnimationSource } from './vrma-retarget'

import { gestureGroupOfHumanBone, gestureRotationTracks } from '@proj-airi/stage-shared/body-motion'
import { QuaternionKeyframeTrack, Vector3 } from 'three'

import { humanBoneOfMMDBone, mmdBoneNamesOfHumanBone, retargetVRMAnimationToMMD } from './vrma-retarget'

const BONE_TRACK = /^\.bones\[(.+)\]\./

/** Helper bones of an arm that VMD motions key, for example `左腕捩` and `右肩P`. They move with their arm. */
const ARM_HELPER = /[肩腕手指]|ひじ/

/**
 * The gesture group of an MMD bone, or undefined for a bone that stays with the idle, for example `センター`, a leg, an IK
 * bone, or an eye.
 */
export function mmdGestureGroupOf(boneName: string): GestureGroup | undefined {
  const human = humanBoneOfMMDBone(boneName)
  if (human)
    return gestureGroupOfHumanBone(human)
  if (ARM_HELPER.test(boneName) && !boneName.includes('ＩＫ') && !boneName.includes('IK')) {
    if (boneName.startsWith('左'))
      return 'leftArm'
    if (boneName.startsWith('右'))
      return 'rightArm'
  }
  return undefined
}

/** The gesture group of a track of an MMD clip, named like `.bones[頭].quaternion`. A morph track stays with the idle. */
export function mmdGestureGroupOfTrack(trackName: string): GestureGroup | undefined {
  const bone = BONE_TRACK.exec(trackName)?.[1]
  return bone ? mmdGestureGroupOf(bone) : undefined
}

/** The keys of a built-in gesture as a VRM Animation, so the retarget can read them. */
export function vrmAnimationOfGesture(gesture: GestureDefinition): VRMAnimationSource {
  const rotation = new Map<VRMHumanBoneName, QuaternionKeyframeTrack>()
  for (const track of gestureRotationTracks(gesture))
    rotation.set(track.bone as VRMHumanBoneName, new QuaternionKeyframeTrack(`${track.bone}.quaternion`, track.times, track.values))
  return {
    duration: gesture.duration,
    // A gesture has no hips motion, so the rest hips only set the scale of a translation that never comes.
    restHipsPosition: new Vector3(0, 1, 0),
    humanoidTracks: { rotation, translation: new Map() },
  }
}

/**
 * Retargets a gesture to an MMD model, and keeps only the bones that the gesture rotates.
 *
 * The retarget writes every mapped bone, and a bone without a track gets its T-pose. A gesture must leave those bones to
 * the idle, so the clip drops them, and it drops the hips and IK positions too.
 */
export function mmdGestureClip(animation: VRMAnimationSource, rig: MMDRig, name: string): AnimationClip {
  const clip = retargetVRMAnimationToMMD(animation, rig, { name })
  const keep = new Set([...animation.humanoidTracks.rotation.keys()].flatMap(bone => mmdBoneNamesOfHumanBone(bone)))
  clip.tracks = clip.tracks.filter((track) => {
    const bone = BONE_TRACK.exec(track.name)?.[1]
    return !!bone && keep.has(bone) && track.name.endsWith('.quaternion')
  })
  return clip
}
