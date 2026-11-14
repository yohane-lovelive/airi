import type { PoseBone } from './pose-applier'
import type { BodyMotionBone, BodyRotation } from './procedural'

import { describe, expect, it } from 'vitest'

import { BodyPoseApplier } from './pose-applier'

function bone(): PoseBone {
  const quaternion = {
    x: 0,
    y: 0,
    z: 0,
    w: 1,
    set(x: number, y: number, z: number, w: number) {
      Object.assign(quaternion, { x, y, z, w })
      return quaternion
    },
  }
  return { quaternion }
}

const zero: BodyRotation = { x: 0, y: 0, z: 0 }

function rotations(head: BodyRotation): Record<BodyMotionBone, BodyRotation> {
  return { spine: zero, chest: zero, neck: zero, head }
}

/** The angle of a rotation about one axis, from its quaternion. */
function angle({ quaternion }: PoseBone, axis: 'x' | 'y' | 'z') {
  return 2 * Math.atan2(quaternion[axis], quaternion.w)
}

describe('bodyPoseApplier', () => {
  it('adds an offset to a bone that no clip moves, and does not add it up over frames', () => {
    const head = bone()
    const applier = new BodyPoseApplier({ head })

    for (let frame = 0; frame < 10; frame++) {
      applier.undo()
      applier.apply(rotations({ x: 0, y: 0.2, z: 0 }))
    }

    expect(angle(head, 'y')).toBeCloseTo(0.2, 6)
  })

  it('adds the offset after the rotation that a clip wrote this frame', () => {
    const head = bone()
    const applier = new BodyPoseApplier({ head })
    applier.apply(rotations({ x: 0, y: 0.2, z: 0 }))

    applier.undo()
    // The clip writes a rotation of 0.5 about Y.
    head.quaternion.set(0, Math.sin(0.25), 0, Math.cos(0.25))
    applier.apply(rotations({ x: 0, y: 0.2, z: 0 }))

    expect(angle(head, 'y')).toBeCloseTo(0.7, 6)
  })

  it('skips bones that the model lacks, and mirrors pitch and roll for a model that faces -Z', () => {
    const head = bone()
    const applier = new BodyPoseApplier({ head }, -1)

    applier.apply(rotations({ x: 0.1, y: 0, z: 0 }))

    expect(applier.available).toEqual(['head'])
    expect(angle(head, 'x')).toBeCloseTo(-0.1, 6)
  })
})
