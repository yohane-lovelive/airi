import type { BodyMotionBone, BodyRotation } from './procedural'

import { BODY_MOTION_BONES } from './procedural'

/** The part of a three.js `Quaternion` that the applier uses, so this package needs no three.js dependency. */
export interface PoseQuaternion {
  x: number
  y: number
  z: number
  w: number
  set: (x: number, y: number, z: number, w: number) => unknown
}

/** A bone, for example a three.js `Object3D`. */
export interface PoseBone {
  quaternion: PoseQuaternion
}

type Quat = readonly [x: number, y: number, z: number, w: number]

/** A quaternion `[x, y, z, w]` of Euler angles in radians, in the order XYZ, as three.js computes it. */
export function quaternionFromEuler({ x, y, z }: BodyRotation): Quat {
  const [c1, c2, c3] = [Math.cos(x / 2), Math.cos(y / 2), Math.cos(z / 2)]
  const [s1, s2, s3] = [Math.sin(x / 2), Math.sin(y / 2), Math.sin(z / 2)]
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ]
}

/** Sets `bone` to its rotation followed by `offset` in the bone's own frame. */
function postMultiply(bone: PoseBone, [bx, by, bz, bw]: Quat) {
  const { x: ax, y: ay, z: az, w: aw } = bone.quaternion
  bone.quaternion.set(
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  )
}

/**
 * Adds the offsets of {@link ProceduralBodyMotion} to the bones of a model, and takes them away again.
 *
 * A clip writes only the bones that it has tracks for. So a frame first calls {@link undo} before the clip runs, and
 * {@link apply} after it. An offset then never adds up over frames, whether the clip moved the bone or not.
 *
 * Use when:
 * - A VRM or MMD renderer adds the procedural layer in its frame loop.
 */
export class BodyPoseApplier {
  private readonly applied = new Map<PoseBone, Quat>()

  /**
   * @param bones The bones of the model. A missing bone skips its part.
   * @param facing `-1` for a model that faces -Z, for example a VRM 0.x model. The layer works in a frame that faces +Z.
   */
  constructor(private readonly bones: Partial<Record<BodyMotionBone, PoseBone>>, private readonly facing: 1 | -1 = 1) {}

  /** The bones that the model has, for the inspector and for tests. */
  get available(): BodyMotionBone[] {
    return BODY_MOTION_BONES.filter(name => this.bones[name])
  }

  /** Removes the offsets of the last frame. */
  undo() {
    for (const [bone, [x, y, z, w]] of this.applied)
      postMultiply(bone, [-x, -y, -z, w])
    this.applied.clear()
  }

  /** Adds the offsets of this frame after the rotations of the clip. Call {@link undo} before the clip runs. */
  apply(rotations: Record<BodyMotionBone, BodyRotation>) {
    for (const name of BODY_MOTION_BONES) {
      const bone = this.bones[name]
      if (!bone)
        continue
      const rotation = rotations[name]
      const offset = quaternionFromEuler({ x: rotation.x * this.facing, y: rotation.y, z: rotation.z * this.facing })
      postMultiply(bone, offset)
      this.applied.set(bone, offset)
    }
  }
}
