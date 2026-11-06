import type { InferOutput } from 'valibot'

import {
  array,
  check,
  finite,
  literal,
  maxValue,
  minLength,
  minValue,
  nonEmpty,
  number,
  optional,
  picklist,
  pipe,
  safeParse,
  strictObject,
  string,
  variant,
} from 'valibot'

import { StageAvatarBoundsPayloadSchema } from '../godot-stage/view-state'

const finiteNumberSchema = pipe(number(), finite())
const positiveNumberSchema = pipe(finiteNumberSchema, minValue(Number.MIN_VALUE))
const weightSchema = pipe(finiteNumberSchema, minValue(0), maxValue(1))
const textSchema = pipe(string(), nonEmpty())

const bodyRotationSchema = strictObject({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  z: finiteNumberSchema,
})

/**
 * One bone of a gesture. The shape is `GestureRotationTrack` of `body-motion`: the frame of a VRM humanoid, and
 * quaternions `[x, y, z, w]` in a flat list. The sidecar converts each quaternion to its own frame.
 */
const rotationTrackSchema = pipe(
  strictObject({
    bone: textSchema,
    times: pipe(array(pipe(finiteNumberSchema, minValue(0))), minLength(1)),
    values: array(finiteNumberSchema),
  }),
  check(track => track.values.length === track.times.length * 4, 'A rotation track needs four values for each time.'),
)

/**
 * A clip for the sidecar to play over the idle. The `keys` form is a built-in or generated gesture, and it moves only
 * the upper body. The `vrma` form is a file that Electron main wrote to disk. A `full` clip replaces the whole idle.
 */
const characterGestureSchema = variant('kind', [
  strictObject({
    kind: literal('keys'),
    id: textSchema,
    part: literal('upper'),
    duration: positiveNumberSchema,
    tracks: pipe(array(rotationTrackSchema), minLength(1)),
  }),
  strictObject({
    kind: literal('vrma'),
    id: textSchema,
    part: picklist(['upper', 'full']),
    path: textSchema,
  }),
])

/**
 * The continuous state of one moment, 30 times each second. The renderer computes it, because the speech and the
 * procedural layer live there. `bones` and `eyes` have the shape of `BodyMotionPose` of `body-motion`.
 */
const characterFrameSchema = strictObject({
  mouth: strictObject({
    A: weightSchema,
    E: weightSchema,
    I: weightSchema,
    O: weightSchema,
    U: weightSchema,
  }),
  bones: strictObject({
    spine: bodyRotationSchema,
    chest: bodyRotationSchema,
    neck: bodyRotationSchema,
    head: bodyRotationSchema,
  }),
  eyes: strictObject({
    yaw: finiteNumberSchema,
    pitch: finiteNumberSchema,
  }),
})

/** What Electron main sends to a display sidecar. A sidecar answers an invalid message with `character.error`. */
export const HostMessageSchema = variant('type', [
  strictObject({
    type: literal('host.scene.apply'),
    payload: strictObject({
      /** `pmx`: the textures load from paths relative to `path`, so the file stays in the folder of its package. */
      format: picklist(['vrm', 'pmx']),
      modelId: textSchema,
      name: textSchema,
      path: textSchema,
    }),
  }),
  strictObject({
    type: literal('host.character.idle'),
    payload: strictObject({
      path: textSchema,
    }),
  }),
  strictObject({
    type: literal('host.character.expression'),
    payload: strictObject({
      name: textSchema,
      intensity: weightSchema,
      /** How long the expression stays before it returns to neutral. Without a value, the sidecar uses its default. */
      holdMs: optional(positiveNumberSchema),
    }),
  }),
  strictObject({
    type: literal('host.character.gesture'),
    payload: characterGestureSchema,
  }),
  strictObject({
    type: literal('host.character.frame'),
    payload: characterFrameSchema,
  }),
  strictObject({
    type: literal('host.shutdown'),
  }),
])

/** What a display sidecar sends to Electron main. */
export const SidecarMessageSchema = variant('type', [
  strictObject({
    type: literal('stage.ready'),
  }),
  strictObject({
    type: literal('stage.fatal'),
    payload: strictObject({
      message: string(),
    }),
  }),
  strictObject({
    type: literal('scene.applied'),
    payload: strictObject({
      modelId: textSchema,
      avatarBounds: StageAvatarBoundsPayloadSchema,
    }),
  }),
  strictObject({
    type: literal('scene.error'),
    payload: strictObject({
      message: string(),
    }),
  }),
  strictObject({
    type: literal('character.error'),
    payload: strictObject({
      message: string(),
      /** The `type` of the host message that failed. */
      type: string(),
    }),
  }),
])

export type HostMessage = InferOutput<typeof HostMessageSchema>
export type SidecarMessage = InferOutput<typeof SidecarMessageSchema>
export type CharacterGesture = InferOutput<typeof characterGestureSchema>
export type CharacterFrame = InferOutput<typeof characterFrameSchema>

/**
 * Parses a message for a sidecar.
 *
 * Use when:
 * - Electron main receives a signal from a renderer and is about to forward it.
 */
export function parseHostMessage(value: unknown): HostMessage {
  const result = safeParse(HostMessageSchema, value)
  if (!result.success)
    throw new Error('Invalid stage sidecar host message.')

  return result.output
}

/**
 * Parses a message from a sidecar.
 *
 * Use when:
 * - Electron main reads the WebSocket of a sidecar.
 */
export function parseSidecarMessage(value: unknown): SidecarMessage {
  const result = safeParse(SidecarMessageSchema, value)
  if (!result.success)
    throw new Error('Invalid stage sidecar message.')

  return result.output
}
