import { describe, expect, it } from 'vitest'

import { gestureFromGeneratedTracks } from './generated'
import { gestureRotationTracks } from './gestures'
import { eulerFromQuaternion, quaternionFromEuler } from './pose-applier'

const radians = Math.PI / 180

/** A track at 20 keys each second, like the output of ARDY, that turns about X by `degreesAt(time)`. */
function track(bone: string, seconds: number, degreesAt: (time: number) => number) {
  const times = Array.from({ length: seconds * 20 + 1 }, (_, index) => index / 20)
  return { bone, times, values: times.flatMap(time => quaternionFromEuler({ x: degreesAt(time) * radians, y: 0, z: 0 })) }
}

const about = { id: 'g1', description: 'swing a sword', tags: ['swing a sword'] }

describe('eulerFromQuaternion', () => {
  it('undoes quaternionFromEuler', () => {
    for (const rotation of [{ x: 0.3, y: -0.5, z: 1.2 }, { x: -1, y: 0.2, z: -0.4 }, { x: 0, y: 0, z: 0 }]) {
      const back = eulerFromQuaternion(quaternionFromEuler(rotation))
      expect(back.x).toBeCloseTo(rotation.x, 6)
      expect(back.y).toBeCloseTo(rotation.y, 6)
      expect(back.z).toBeCloseTo(rotation.z, 6)
    }
  })
})

describe('gestureFromGeneratedTracks', () => {
  it('keeps the upper body only, so the hips and the legs stay with the idle', () => {
    const gesture = gestureFromGeneratedTracks(about, [
      track('hips', 2, () => 10),
      track('leftUpperLeg', 2, () => 30),
      track('rightUpperArm', 2, time => time * 20),
      track('head', 2, () => 5),
    ], 2)!

    expect(Object.keys(gesture.tracks)).toContain('rightUpperArm')
    expect(Object.keys(gesture.tracks)).toContain('head')
    expect(gesture.tracks.hips).toBeUndefined()
    expect(gesture.tracks.leftUpperLeg).toBeUndefined()
    expect(gesture).toMatchObject({ id: 'g1', description: 'swing a sword', duration: 2 })
  })

  it('keeps 10 keys each second and the last key, and the angles in degrees', () => {
    const gesture = gestureFromGeneratedTracks(about, [track('head', 2, () => 12)], 2)!

    const head = gesture.tracks.head
    expect(head).toHaveLength(21)
    expect(head[0]).toEqual([0, 12, 0, 0])
    expect(head.at(-1)![0]).toBe(2)
  })

  it('smooths a jitter of one key', () => {
    const gesture = gestureFromGeneratedTracks(about, [track('head', 1, time => (Math.abs(time - 0.5) < 1e-6 ? 20 : 0))], 1)!

    const jitter = gesture.tracks.head.find(([time]) => time === 0.5)!
    expect(jitter[1]).toBeGreaterThan(5)
    expect(jitter[1]).toBeLessThan(15)
  })

  it('gives relaxed fingers to a hand without finger tracks, and the result plays as quaternion tracks', () => {
    const gesture = gestureFromGeneratedTracks(about, [track('rightUpperArm', 1, () => 0)], 1)!

    expect(gesture.tracks.leftIndexProximal).toEqual([[0, 0, 0, -20], [1, 0, 0, -20]])
    expect(gesture.tracks.rightLittleIntermediate).toEqual([[0, 0, 0, 20], [1, 0, 0, 20]])
    for (const { values } of gestureRotationTracks(gesture)) {
      for (let index = 0; index < values.length; index += 4)
        expect(Math.hypot(...values.slice(index, index + 4))).toBeCloseTo(1, 6)
    }
  })

  it('gives nothing when no track of the upper body remains', () => {
    expect(gestureFromGeneratedTracks(about, [track('hips', 1, () => 0)], 1)).toBeUndefined()
  })
})
