import type { GestureDefinition, GestureKey, GestureRotationTrack } from './gestures'

import { gestureGroupOfHumanBone } from './gesture-layer'
import { fingerCurl } from './gestures'
import { eulerFromQuaternion } from './pose-applier'

/** A generated clip keeps this many keys each second. A generator gives more, for example 20. */
const KEYS_PER_SECOND = 10
/** The curl of the fingers in degrees. A generator moves no fingers, and flat fingers look stiff. */
const RELAXED_FINGER_CURL = 20

type Quat = readonly [number, number, number, number]

function quatAt(values: readonly number[], index: number): Quat {
  return [values[index * 4], values[index * 4 + 1], values[index * 4 + 2], values[index * 4 + 3]]
}

/** Averages a key with its neighbours. Each neighbour turns to the side of the key first, so the sum cannot cancel. */
function smoothed(values: readonly number[], count: number): Quat[] {
  return Array.from({ length: count }, (_, index) => {
    const center = quatAt(values, index)
    const sum = [0, 0, 0, 0]
    for (const [offset, weight] of [[-1, 0.25], [0, 0.5], [1, 0.25]] as const) {
      const quat = quatAt(values, Math.min(count - 1, Math.max(0, index + offset)))
      const sign = quat[0] * center[0] + quat[1] * center[1] + quat[2] * center[2] + quat[3] * center[3] < 0 ? -1 : 1
      for (let axis = 0; axis < 4; axis++)
        sum[axis] += quat[axis] * sign * weight
    }
    const length = Math.hypot(...sum) || 1
    return [sum[0] / length, sum[1] / length, sum[2] / length, sum[3] / length]
  })
}

function degrees(radians: number) {
  // `+ 0` turns -0 into 0, so the stored keys read cleanly.
  return Math.round(radians * 1800 / Math.PI) / 10 + 0
}

/** The keys of one bone: smoothed, at {@link KEYS_PER_SECOND}, with the last key kept. */
function keysOf(track: GestureRotationTrack): GestureKey[] {
  const count = Math.min(track.times.length, Math.floor(track.values.length / 4))
  const quats = smoothed(track.values, count)
  const keys: GestureKey[] = []
  for (let index = 0; index < count; index++) {
    const time = track.times[index]
    const last = keys.at(-1)
    if (last && time - last[0] < 1 / KEYS_PER_SECOND - 1e-6 && index !== count - 1)
      continue
    const { x, y, z } = eulerFromQuaternion(quats[index])
    keys.push([Math.round(time * 1000) / 1000, degrees(x), degrees(y), degrees(z)])
  }
  return keys
}

/**
 * Turns the rotation tracks of a generated clip into a gesture of the upper body.
 *
 * - The playback rules of ADR 2026-10-28 lock the lower body, so the hips, the legs, and the eyes lose their tracks.
 *   The clip keeps no translation, so the hips do not travel.
 * - The keys are smoothed and kept at 10 each second.
 * - A hand without finger tracks gets relaxed fingers.
 *
 * Use when:
 * - A text-to-motion service gave a `.vrma` clip, and the library stores it as a gesture that both renderers play.
 *
 * Returns:
 * - The gesture, or undefined when no track of the upper body remains.
 */
export function gestureFromGeneratedTracks(about: { id: string, description: string, tags: readonly string[] }, tracks: readonly GestureRotationTrack[], duration: number): GestureDefinition | undefined {
  const upper = tracks.filter(track => gestureGroupOfHumanBone(track.bone) !== undefined && track.times.length > 0)
  if (upper.length === 0 || !(duration > 0))
    return undefined

  const keyed: Record<string, readonly GestureKey[]> = Object.fromEntries(upper.map(track => [track.bone, keysOf(track)]))
  for (const side of ['left', 'right'] as const) {
    if (!Object.keys(keyed).some(bone => bone.startsWith(side) && /Index|Middle|Ring|Little|Thumb/.test(bone)))
      Object.assign(keyed, fingerCurl(side, [[0, RELAXED_FINGER_CURL], [duration, RELAXED_FINGER_CURL]]))
  }
  return { ...about, duration, tracks: keyed }
}
