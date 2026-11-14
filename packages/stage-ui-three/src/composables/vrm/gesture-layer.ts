import type { VRMCore, VRMHumanBoneName } from '@pixiv/three-vrm-core'
import type { GestureClipSource } from '@proj-airi/stage-shared/body-motion'
import type { AnimationAction, AnimationMixer } from 'three'

import { VRMHumanBoneList } from '@pixiv/three-vrm-core'
import { gestureGroupOfHumanBone, GestureLayer, gestureRotationTracks } from '@proj-airi/stage-shared/body-motion'
import { AnimationClip, LoopOnce, LoopRepeat, QuaternionKeyframeTrack } from 'three'

import { clipFromVRMAnimation, loadVRMAnimation } from './animation'

const layers = new WeakMap<AnimationMixer, GestureLayer<AnimationClip, AnimationAction>>()
const clips = new WeakMap<VRMCore, Map<string, AnimationClip>>()

/** The humanoid bone of each normalized bone node, by node name, as the tracks of a VRM clip name them. */
function humanBonesByNode(vrm: VRMCore) {
  const byNode = new Map<string, VRMHumanBoneName>()
  for (const bone of VRMHumanBoneList) {
    const node = vrm.humanoid.getNormalizedBoneNode(bone)
    if (node)
      byNode.set(node.name, bone)
  }
  return byNode
}

function groupOfTrack(byNode: Map<string, VRMHumanBoneName>, trackName: string) {
  const dot = trackName.lastIndexOf('.')
  const bone = byNode.get(trackName.slice(0, dot))
  return bone && trackName.endsWith('.quaternion') ? gestureGroupOfHumanBone(bone) : undefined
}

/**
 * The gesture layer of a VRM model and its mixer. The idle plays in parts, so a gesture can take the head or an arm
 * while the rest keeps the idle. A reused model keeps its layer, because the layer belongs to its mixer.
 */
export function vrmGestureLayer(vrm: VRMCore, mixer: AnimationMixer) {
  let layer = layers.get(mixer)
  if (layer)
    return layer

  const byNode = humanBonesByNode(vrm)
  const subclips = new WeakMap<AnimationClip, Map<string, AnimationClip>>()
  layer = new GestureLayer<AnimationClip, AnimationAction>({
    trackNames: clip => clip.tracks.map(track => track.name),
    duration: clip => clip.duration,
    subclip: (clip, name, keep) => {
      let parts = subclips.get(clip)
      if (!parts) {
        parts = new Map()
        subclips.set(clip, parts)
      }
      let part = parts.get(name)
      if (!part) {
        part = new AnimationClip(`${clip.name}:${name}`, clip.duration, clip.tracks.filter(track => keep(track.name)))
        parts.set(name, part)
      }
      return part
    },
    groupOfTrack: trackName => groupOfTrack(byNode, trackName),
    action: (clip, loop) => {
      const action = mixer.clipAction(clip)
      action.setLoop(loop === 'repeat' ? LoopRepeat : LoopOnce, loop === 'repeat' ? Number.POSITIVE_INFINITY : 1)
      action.clampWhenFinished = loop === 'once'
      return action
    },
  })
  layers.set(mixer, layer)
  return layer
}

/** The layer of a mixer, if a model already made one. */
export function existingVrmGestureLayer(mixer: AnimationMixer) {
  return layers.get(mixer)
}

async function loadVRMAnimationData(vrma: ArrayBuffer) {
  const url = URL.createObjectURL(new Blob([vrma]))
  try {
    return await loadVRMAnimation(url)
  }
  finally {
    URL.revokeObjectURL(url)
  }
}

/** How a gesture plays on a VRM model. */
export interface VrmGestureOptions {
  /**
   * Plays the expression tracks of an imported clip. A marker with an emotion turns this off, so the emotion of the
   * marker shows instead of the expression of the clip.
   *
   * @default false
   */
  withExpressions?: boolean
}

/**
 * Builds the clip of a gesture for a VRM model, and keeps it for the next play.
 *
 * A built-in gesture faces +Z. A VRM 0.x model faces -Z, so its keys turn half a turn about Y. An upper-body clip keeps
 * only the rotations of the bones that a gesture can take, and its expression tracks when `withExpressions` is on.
 */
export async function vrmGestureClip(vrm: VRMCore, source: GestureClipSource, options: VrmGestureOptions = {}): Promise<AnimationClip | undefined> {
  let cache = clips.get(vrm)
  if (!cache) {
    cache = new Map()
    clips.set(vrm, cache)
  }
  const key = `${source.id}:${options.withExpressions ? 'face' : 'body'}`
  const cached = cache.get(key)
  if (cached)
    return cached

  let clip: AnimationClip | undefined
  if (source.kind === 'keys') {
    const mirror = vrm.meta?.metaVersion === '0' ? -1 : 1
    const tracks = gestureRotationTracks(source.gesture).flatMap(({ bone, times, values }) => {
      const node = vrm.humanoid.getNormalizedBoneNode(bone as VRMHumanBoneName)
      if (!node)
        return []
      const turned = values.map((value, index) => index % 4 === 0 || index % 4 === 2 ? value * mirror : value)
      return [new QuaternionKeyframeTrack(`${node.name}.quaternion`, times, turned)]
    })
    clip = new AnimationClip(source.id, source.gesture.duration, tracks)
  }
  else {
    clip = await clipFromVRMAnimation(vrm, await loadVRMAnimationData(source.vrma))
    if (clip && source.part === 'upper') {
      const byNode = humanBonesByNode(vrm)
      // Expression tracks drive the weights of the VRM expressions, which no gesture group holds.
      clip.tracks = clip.tracks.filter(track => groupOfTrack(byNode, track.name) !== undefined || (!!options.withExpressions && track.name.endsWith('.weight')))
    }
  }
  if (clip)
    cache.set(key, clip)
  return clip
}

/**
 * Plays a gesture on a VRM model. An upper-body gesture takes only the parts that it moves. A `full` clip plays instead
 * of the whole idle and gives it back when it ends.
 *
 * @returns false when the model cannot play the clip, for example without the bones.
 */
export async function playVrmGesture(vrm: VRMCore, mixer: AnimationMixer, source: GestureClipSource, options: VrmGestureOptions = {}): Promise<boolean> {
  const clip = await vrmGestureClip(vrm, source, options)
  if (!clip || clip.tracks.length === 0)
    return false
  const layer = vrmGestureLayer(vrm, mixer)
  if (source.part === 'upper')
    return layer.playGesture(clip)

  layer.fadeIdleOut()
  const action = mixer.clipAction(clip)
  action.reset().setLoop(LoopOnce, 1).fadeIn(0.4).play()
  action.clampWhenFinished = true
  const onFinished = (event: { action: AnimationAction }) => {
    if (event.action !== action)
      return
    mixer.removeEventListener('finished', onFinished)
    action.fadeOut(0.4)
    layer.fadeIdleIn()
  }
  mixer.addEventListener('finished', onFinished)
  return true
}
