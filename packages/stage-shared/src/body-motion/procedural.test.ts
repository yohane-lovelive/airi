import type { BodyMotionInput, BodyMotionPose } from './procedural'

import { describe, expect, it } from 'vitest'

import { BODY_MOTION_TUNING, ProceduralBodyMotion } from './procedural'

const FRAME = 1 / 60

/** Runs the layer for `seconds` with the same input, and returns the last pose. */
function run(motion: ProceduralBodyMotion, seconds: number, input: BodyMotionInput): BodyMotionPose {
  let pose = motion.update(0, input)
  for (let time = 0; time < seconds; time += FRAME)
    pose = motion.update(FRAME, input)
  return pose
}

/** A random source that answers the values in order, then repeats the last one. */
function sequence(...values: number[]) {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

const quiet: BodyMotionInput = { thinking: false, speechLevel: 0 }

describe('proceduralBodyMotion', () => {
  it('breathes with a small chest rotation that stays within its amount', () => {
    const motion = new ProceduralBodyMotion({ random: () => 0 })
    const chest: number[] = []
    for (let time = 0; time < BODY_MOTION_TUNING.breathPeriodSeconds; time += FRAME)
      chest.push(motion.update(FRAME, quiet).bones.chest.x)

    expect(Math.max(...chest)).toBeCloseTo(BODY_MOTION_TUNING.breathChest, 3)
    expect(Math.min(...chest)).toBeCloseTo(-BODY_MOTION_TUNING.breathChest, 3)
  })

  it('turns the head before the neck toward the gaze, and both turn only their share of it', () => {
    const motion = new ProceduralBodyMotion({ random: () => 0 })
    const gaze = { yaw: 0.5, pitch: 0.2 }

    const early = run(motion, 0.3, { ...quiet, gaze })
    expect(early.bones.head.y / (gaze.yaw * BODY_MOTION_TUNING.headShare)).toBeGreaterThan(early.bones.neck.y / (gaze.yaw * BODY_MOTION_TUNING.neckShare))

    const settled = run(motion, 5, { ...quiet, gaze })
    expect(settled.bones.head.y).toBeCloseTo(gaze.yaw * BODY_MOTION_TUNING.headShare, 3)
    expect(settled.bones.neck.y).toBeCloseTo(gaze.yaw * BODY_MOTION_TUNING.neckShare, 3)
    expect(settled.bones.neck.x).toBeCloseTo(gaze.pitch * BODY_MOTION_TUNING.neckShare, 3)
  })

  it('limits a gaze far to the side', () => {
    const motion = new ProceduralBodyMotion({ random: () => 0 })

    const pose = run(motion, 5, { ...quiet, gaze: { yaw: 3, pitch: 0 } })

    expect(pose.bones.head.y).toBeCloseTo(BODY_MOTION_TUNING.gazeLimit.yaw * BODY_MOTION_TUNING.headShare, 3)
  })

  it('looks away and up to one side while it thinks, and back after', () => {
    // The phases take three values, then the side of the thought.
    const motion = new ProceduralBodyMotion({ random: sequence(0, 0, 0, 0.9) })

    const thinking = run(motion, 3, { ...quiet, gaze: { yaw: 0, pitch: 0 }, thinking: true })
    expect(thinking.bones.head.y).toBeCloseTo(BODY_MOTION_TUNING.thinkingAway.yaw * BODY_MOTION_TUNING.headShare, 3)
    expect(thinking.bones.head.x).toBeLessThan(0)
    expect(thinking.eyes.yaw).toBeCloseTo(BODY_MOTION_TUNING.thinkingEyes.yaw, 3)

    const after = run(motion, 5, { ...quiet, gaze: { yaw: 0, pitch: 0 } })
    expect(after.bones.head.y).toBeCloseTo(0, 3)
    expect(after.eyes.yaw).toBeCloseTo(0, 3)
  })

  it('nods once on a speech peak, and not again until the speech rests and the gap has passed', () => {
    // No nod is skipped: the random source stays at 0.9, above the skip chance.
    const motion = new ProceduralBodyMotion({ random: () => 0.9 })
    const nodsIn = (seconds: number, level: number) => {
      let nods = 0
      let nodding = false
      for (let time = 0; time < seconds; time += FRAME) {
        const pitch = motion.update(FRAME, { ...quiet, speechLevel: level }).bones.head.x
        if (pitch > 0.01 && !nodding)
          nods++
        nodding = pitch > 0.01
      }
      return nods
    }

    expect(nodsIn(3, 0.8)).toBe(1)
    expect(nodsIn(0.2, 0)).toBe(0)
    expect(nodsIn(0.5, 0.8)).toBe(1)
    // The speech rests and peaks again within the gap, so no nod comes.
    nodsIn(0.1, 0)
    expect(nodsIn(0.3, 0.8)).toBe(0)
  })

  it('skips a share of the peaks', () => {
    const motion = new ProceduralBodyMotion({ random: () => 0.1 })

    const pose = run(motion, 1, { ...quiet, speechLevel: 0.9 })

    expect(pose.bones.head.x).toBeCloseTo(0, 2)
  })
})
