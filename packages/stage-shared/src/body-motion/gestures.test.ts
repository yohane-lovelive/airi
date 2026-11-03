import { describe, expect, it } from 'vitest'

import { gestureGroupOfHumanBone } from './gesture-layer'
import { BUILT_IN_GESTURES, gestureRotationTracks } from './gestures'

describe('built-in gestures', () => {
  it('keys each track within the duration, in order, and only on bones that a gesture can move', () => {
    for (const gesture of BUILT_IN_GESTURES) {
      expect(new Set(BUILT_IN_GESTURES.map(other => other.id)).size).toBe(BUILT_IN_GESTURES.length)
      for (const [bone, keys] of Object.entries(gesture.tracks)) {
        expect(gestureGroupOfHumanBone(bone), `${gesture.id} ${bone}`).toBeDefined()
        const times = keys.map(([time]) => time)
        expect(times[0]).toBe(0)
        expect(times.at(-1)).toBe(gesture.duration)
        expect(times).toEqual([...times].sort((a, b) => a - b))
      }
    }
  })

  it('turns degrees into unit quaternions, one track for each bone', () => {
    const nod = BUILT_IN_GESTURES.find(gesture => gesture.id === 'nod')!

    const tracks = gestureRotationTracks(nod)

    const head = tracks.find(track => track.bone === 'head')!
    expect(head.values).toHaveLength(head.times.length * 4)
    // 16 degrees about X at the second key.
    expect(head.values[4]).toBeCloseTo(Math.sin((16 * Math.PI) / 360), 6)
    for (let index = 0; index < head.values.length; index += 4)
      expect(Math.hypot(...head.values.slice(index, index + 4))).toBeCloseTo(1, 6)
  })
})
