/** A rotation offset as Euler angles in radians, in the order XYZ. */
export interface BodyRotation {
  x: number
  y: number
  z: number
}

/** The bones that the procedural layer moves. A model without one of them skips its part. */
export const BODY_MOTION_BONES = ['spine', 'chest', 'neck', 'head'] as const

export type BodyMotionBone = typeof BODY_MOTION_BONES[number]

/**
 * Where the character looks, as the rotation that turns the face to the target, in radians.
 *
 * The frame faces +Z with +Y up. A positive `yaw` turns toward +X, and a positive `pitch` turns down.
 */
export interface BodyGaze {
  yaw: number
  pitch: number
}

export interface BodyMotionInput {
  /** The target of the eyes. Without one, the head and the neck return to the front. */
  gaze?: BodyGaze
  /** While the chat model writes a reply, the gaze moves away, as a person looks away to think. */
  thinking: boolean
  /** The loudness of the speech of the character, from 0 to 1. */
  speechLevel: number
}

/** The offsets of one frame. A caller adds each rotation after the motion of the clip. */
export interface BodyMotionPose {
  bones: Record<BodyMotionBone, BodyRotation>
  /** An extra eye direction while the character thinks, on the scale of {@link BodyGaze}. */
  eyes: BodyGaze
}

export interface ProceduralBodyMotionOptions {
  /** @default Math.random */
  random?: () => number
}

/** Tuning of the layer. The values are small, so the layer stays under the motion of a clip. */
export const BODY_MOTION_TUNING = {
  breathPeriodSeconds: 4.5,
  breathChest: 0.015,
  breathSpine: 0.006,
  swaySpine: 0.012,
  swayHeadRoll: 0.015,
  /** The share of the gaze that the neck and the head turn. The eyes turn the rest. */
  neckShare: 0.3,
  headShare: 0.35,
  /** The neck follows later than the head, so the motion starts at the head. Seconds of smoothing. */
  neckFollowSeconds: 0.6,
  headFollowSeconds: 0.3,
  gazeLimit: { yaw: 0.8, pitch: 0.5 },
  thinkingAway: { yaw: 0.45, pitch: -0.25 },
  thinkingEyes: { yaw: 0.3, pitch: -0.2 },
  eyesFollowSeconds: 0.25,
  /** A nod starts when the speech level rises above `start` after it fell below `rest`. */
  nodLevel: { start: 0.45, rest: 0.2 },
  nodMinGapSeconds: 1.5,
  /** A share of the peaks gets no nod, so the nods do not keep time like a metronome. */
  nodSkipChance: 0.4,
  nodSeconds: 0.5,
  nodHead: 0.09,
  nodNeck: 0.04,
} as const

function smoothing(delta: number, seconds: number) {
  return 1 - Math.exp(-delta / seconds)
}

function clamp(value: number, limit: number) {
  return Math.max(-limit, Math.min(limit, value))
}

/**
 * Moves the body of a 3D model without clips: breath, a small sway, a neck and a head that follow the gaze late, a
 * gaze that moves away while the model thinks, and nods on the peaks of the speech.
 *
 * It returns offsets and changes no bone, so VRM and MMD models share it. Each call advances its clock by `delta`.
 *
 * Use when:
 * - A model renderer adds natural motion over its idle clip each frame.
 */
export class ProceduralBodyMotion {
  private readonly random: () => number
  private readonly phases: { sway: number, swayYaw: number, roll: number }
  private time = 0
  private neck: BodyGaze = { yaw: 0, pitch: 0 }
  private head: BodyGaze = { yaw: 0, pitch: 0 }
  private eyes: BodyGaze = { yaw: 0, pitch: 0 }
  private awaySide = 1
  private wasThinking = false
  private nodRested = true
  private sinceNod = Number.POSITIVE_INFINITY
  private nodTime: number | undefined

  constructor(options: ProceduralBodyMotionOptions = {}) {
    this.random = options.random ?? Math.random
    const turn = () => this.random() * Math.PI * 2
    this.phases = { sway: turn(), swayYaw: turn(), roll: turn() }
  }

  update(delta: number, input: BodyMotionInput): BodyMotionPose {
    const tuning = BODY_MOTION_TUNING
    this.time += delta

    if (input.thinking && !this.wasThinking)
      this.awaySide = this.random() < 0.5 ? -1 : 1
    this.wasThinking = input.thinking

    const target: BodyGaze = input.thinking
      ? { yaw: tuning.thinkingAway.yaw * this.awaySide, pitch: tuning.thinkingAway.pitch }
      : { yaw: clamp(input.gaze?.yaw ?? 0, tuning.gazeLimit.yaw), pitch: clamp(input.gaze?.pitch ?? 0, tuning.gazeLimit.pitch) }
    this.follow(this.neck, target, tuning.neckShare, smoothing(delta, tuning.neckFollowSeconds))
    this.follow(this.head, target, tuning.headShare, smoothing(delta, tuning.headFollowSeconds))
    const eyesTarget = input.thinking
      ? { yaw: tuning.thinkingEyes.yaw * this.awaySide, pitch: tuning.thinkingEyes.pitch }
      : { yaw: 0, pitch: 0 }
    this.follow(this.eyes, eyesTarget, 1, smoothing(delta, tuning.eyesFollowSeconds))

    const nod = this.nod(delta, input.speechLevel)
    const breath = Math.sin((this.time / tuning.breathPeriodSeconds) * Math.PI * 2)
    const sway = (period: number, phase: number) => Math.sin((this.time / period) * Math.PI * 2 + phase)

    return {
      bones: {
        // Breathing in lifts the chest a little, which is a rotation back, so the sign is negative.
        spine: {
          x: -tuning.breathSpine * breath,
          y: tuning.swaySpine * sway(11.1, this.phases.swayYaw),
          z: tuning.swaySpine * 0.8 * sway(7.3, this.phases.sway),
        },
        chest: { x: -tuning.breathChest * breath, y: 0, z: 0 },
        neck: { x: this.neck.pitch + tuning.nodNeck * nod, y: this.neck.yaw, z: 0 },
        head: { x: this.head.pitch + tuning.nodHead * nod, y: this.head.yaw, z: tuning.swayHeadRoll * sway(9.7, this.phases.roll) },
      },
      eyes: { ...this.eyes },
    }
  }

  private follow(current: BodyGaze, target: BodyGaze, share: number, rate: number) {
    current.yaw += (target.yaw * share - current.yaw) * rate
    current.pitch += (target.pitch * share - current.pitch) * rate
  }

  /** The nod amount of this frame, from 0 to 1. */
  private nod(delta: number, level: number) {
    const tuning = BODY_MOTION_TUNING
    this.sinceNod += delta
    if (level < tuning.nodLevel.rest)
      this.nodRested = true
    if (this.nodRested && level >= tuning.nodLevel.start && this.sinceNod >= tuning.nodMinGapSeconds) {
      this.nodRested = false
      if (this.random() >= tuning.nodSkipChance) {
        this.sinceNod = 0
        this.nodTime = 0
      }
    }
    if (this.nodTime === undefined)
      return 0
    this.nodTime += delta
    if (this.nodTime >= tuning.nodSeconds) {
      this.nodTime = undefined
      return 0
    }
    return Math.sin((this.nodTime / tuning.nodSeconds) * Math.PI)
  }
}
