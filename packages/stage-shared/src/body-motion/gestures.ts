import { quaternionFromEuler } from './pose-applier'

/** One rotation key of a bone: the time in seconds, and the Euler angles X, Y, and Z in degrees. */
export type GestureKey = readonly [time: number, x: number, y: number, z: number]

/**
 * A gesture that ships with the app, as data, so its license is clear and a review can read it.
 *
 * The keys rotate the normalized bones of a VRM humanoid, relative to its T-pose. The frame faces +Z with +Y up: a
 * positive X rotation turns the head down, and the left arm points to +X. MMD models play the same data through the
 * retarget of `@proj-airi/stage-ui-mmd`.
 */
export interface GestureDefinition {
  id: string
  description: string
  /** Words that a marker can use for the gesture, in English and Japanese. A Japanese tag can be a stem, for example `うなず`. */
  tags: readonly string[]
  duration: number
  tracks: Readonly<Record<string, readonly GestureKey[]>>
}

/** The upper arm hangs down at the side. A key at the start and the end uses it, and the cross-fade hides the gap to the idle. */
const LEFT_ARM_DOWN = -72
const RIGHT_ARM_DOWN = 72

/** Curls the index, middle, ring, and little fingers of one hand. Each key is a time in seconds and the curl in degrees. */
export function fingerCurl(side: 'left' | 'right', curl: readonly (readonly [time: number, degrees: number])[]) {
  const sign = side === 'left' ? -1 : 1
  const tracks: Record<string, GestureKey[]> = {}
  for (const finger of ['Index', 'Middle', 'Ring', 'Little']) {
    for (const joint of ['Proximal', 'Intermediate'])
      tracks[`${side}${finger}${joint}`] = curl.map(([time, degrees]) => [time, 0, 0, sign * degrees])
  }
  return tracks
}

export const BUILT_IN_GESTURES: readonly GestureDefinition[] = [
  {
    id: 'nod',
    description: 'Nods twice, to agree.',
    tags: ['nod', 'agree', 'yes', 'understand', 'うなず', '頷', 'うんうん', '同意', '納得'],
    duration: 1.1,
    tracks: {
      neck: [[0, 0, 0, 0], [0.25, 6, 0, 0], [0.5, 0, 0, 0], [0.75, 4, 0, 0], [1.1, 0, 0, 0]],
      head: [[0, 0, 0, 0], [0.25, 16, 0, 0], [0.5, 2, 0, 0], [0.75, 12, 0, 0], [1.1, 0, 0, 0]],
    },
  },
  {
    id: 'tilt-head',
    description: 'Tilts the head to one side, puzzled.',
    tags: ['tilt', 'wonder', 'puzzle', 'confuse', 'curious', 'かしげ', '傾げ', '不思議', '疑問', 'はてな'],
    duration: 1.7,
    tracks: {
      neck: [[0, 0, 0, 0], [0.4, 0, 0, 6], [1.3, 0, 0, 6], [1.7, 0, 0, 0]],
      head: [[0, 0, 0, 0], [0.4, 0, 0, 15], [1.3, 0, 0, 15], [1.7, 0, 0, 0]],
    },
  },
  {
    id: 'wave',
    description: 'Raises the right hand and waves.',
    tags: ['wave', 'hello', 'greet', 'bye', 'goodbye', '手を振', '振る', '挨拶', 'こんにちは', 'バイバイ', 'またね'],
    duration: 2.4,
    tracks: {
      rightUpperArm: [[0, 0, 0, RIGHT_ARM_DOWN], [0.45, 0, 15, -15], [2.0, 0, 15, -15], [2.4, 0, 0, RIGHT_ARM_DOWN]],
      rightLowerArm: [[0, 0, 0, 0], [0.45, 0, 0, -75], [0.8, 0, 0, -55], [1.15, 0, 0, -95], [1.5, 0, 0, -55], [1.85, 0, 0, -95], [2.05, 0, 0, -75], [2.4, 0, 0, 0]],
    },
  },
  {
    id: 'shrug',
    description: 'Shrugs with the palms up, unsure.',
    tags: ['shrug', 'dunno', 'whatever', 'unsure', 'すくめ', '分からな', 'わからな', 'さあ'],
    duration: 1.4,
    tracks: {
      head: [[0, 0, 0, 0], [0.35, 0, 0, 8], [0.95, 0, 0, 8], [1.4, 0, 0, 0]],
      leftShoulder: [[0, 0, 0, 0], [0.35, 0, 0, 14], [0.95, 0, 0, 14], [1.4, 0, 0, 0]],
      rightShoulder: [[0, 0, 0, 0], [0.35, 0, 0, -14], [0.95, 0, 0, -14], [1.4, 0, 0, 0]],
      leftUpperArm: [[0, 0, 0, LEFT_ARM_DOWN], [0.35, 0, 0, -76], [0.95, 0, 0, -76], [1.4, 0, 0, LEFT_ARM_DOWN]],
      rightUpperArm: [[0, 0, 0, RIGHT_ARM_DOWN], [0.35, 0, 0, 76], [0.95, 0, 0, 76], [1.4, 0, 0, RIGHT_ARM_DOWN]],
      leftLowerArm: [[0, 0, 0, 0], [0.35, 0, -95, 0], [0.95, 0, -95, 0], [1.4, 0, 0, 0]],
      rightLowerArm: [[0, 0, 0, 0], [0.35, 0, 95, 0], [0.95, 0, 95, 0], [1.4, 0, 0, 0]],
      // The hands turn about the forearm, so the palms face up.
      leftHand: [[0, 0, 0, 0], [0.35, -80, 0, 0], [0.95, -80, 0, 0], [1.4, 0, 0, 0]],
      rightHand: [[0, 0, 0, 0], [0.35, -80, 0, 0], [0.95, -80, 0, 0], [1.4, 0, 0, 0]],
    },
  },
  {
    id: 'cross-arms',
    description: 'Crosses the arms to think.',
    tags: ['cross', 'fold', 'arms', 'think', 'ponder', 'hmm', '腕を組', '腕組', '考え', 'うーん'],
    duration: 2.8,
    tracks: {
      leftUpperArm: [[0, 0, 0, LEFT_ARM_DOWN], [0.5, 0, -45, -65], [2.3, 0, -45, -65], [2.8, 0, 0, LEFT_ARM_DOWN]],
      rightUpperArm: [[0, 0, 0, RIGHT_ARM_DOWN], [0.5, 0, 45, 65], [2.3, 0, 45, 65], [2.8, 0, 0, RIGHT_ARM_DOWN]],
      leftLowerArm: [[0, 0, 0, 0], [0.5, 0, -110, 0], [2.3, 0, -110, 0], [2.8, 0, 0, 0]],
      rightLowerArm: [[0, 0, 0, 0], [0.5, 0, 110, 0], [2.3, 0, 110, 0], [2.8, 0, 0, 0]],
    },
  },
  {
    id: 'hand-on-chest',
    description: 'Puts the right hand on the chest, relieved or grateful.',
    tags: ['chest', 'heart', 'relief', 'relieved', 'grateful', 'sincere', '胸に手', '胸', '安心', 'ほっと', 'ホッと', '感謝'],
    duration: 2.4,
    tracks: {
      rightUpperArm: [[0, 0, 0, RIGHT_ARM_DOWN], [0.5, 0, 30, 68], [1.9, 0, 30, 68], [2.4, 0, 0, RIGHT_ARM_DOWN]],
      rightLowerArm: [[0, 0, 0, 0], [0.5, 0, 112, 0], [1.9, 0, 112, 0], [2.4, 0, 0, 0]],
      rightHand: [[0, 0, 0, 0], [0.5, 0, 0, -20], [1.9, 0, 0, -20], [2.4, 0, 0, 0]],
    },
  },
  {
    id: 'bow',
    description: 'Bows politely, to thank or to apologize.',
    tags: ['bow', 'thank', 'sorry', 'apologize', 'polite', 'お辞儀', 'おじぎ', 'ありがと', 'ごめん', 'すみません', '申し訳'],
    duration: 2.2,
    tracks: {
      spine: [[0, 0, 0, 0], [0.5, 22, 0, 0], [1.4, 22, 0, 0], [2.2, 0, 0, 0]],
      chest: [[0, 0, 0, 0], [0.5, 8, 0, 0], [1.4, 8, 0, 0], [2.2, 0, 0, 0]],
      head: [[0, 0, 0, 0], [0.5, 10, 0, 0], [1.4, 10, 0, 0], [2.2, 0, 0, 0]],
    },
  },
  {
    id: 'fist-pump',
    description: 'Pumps the right fist, excited.',
    tags: ['fist', 'pump', 'victory', 'cheer', 'excite', 'hooray', 'ガッツ', 'やった', 'よし', '勝利', '喜'],
    duration: 1.6,
    tracks: {
      rightUpperArm: [[0, 0, 0, RIGHT_ARM_DOWN], [0.3, 0, 20, 30], [0.55, 0, 20, 10], [0.8, 0, 20, 30], [1.05, 0, 20, 10], [1.6, 0, 0, RIGHT_ARM_DOWN]],
      rightLowerArm: [[0, 0, 0, 0], [0.3, 0, 0, -120], [1.05, 0, 0, -120], [1.6, 0, 0, 0]],
      ...fingerCurl('right', [[0, 0], [0.3, 80], [1.05, 80], [1.6, 0]]),
    },
  },
]

/**
 * What a renderer plays: the keys of a built-in or generated gesture, or the data of an imported `.vrma` file. A `full`
 * clip moves the hips or the legs, so it replaces the whole idle for its duration.
 */
export type GestureClipSource
  = | { kind: 'keys', id: string, part: 'upper', gesture: GestureDefinition }
    | { kind: 'vrma', id: string, part: 'upper' | 'full', vrma: ArrayBuffer }

/** The rotation keys of one bone, as quaternions `[x, y, z, w]` in a flat list, like a three.js `QuaternionKeyframeTrack`. */
export interface GestureRotationTrack {
  bone: string
  times: number[]
  values: number[]
}

/** Turns the degrees of a gesture into quaternion keys, one track for each bone. */
export function gestureRotationTracks(gesture: GestureDefinition): GestureRotationTrack[] {
  const radians = Math.PI / 180
  return Object.entries(gesture.tracks).map(([bone, keys]) => ({
    bone,
    times: keys.map(([time]) => time),
    values: keys.flatMap(([, x, y, z]) => quaternionFromEuler({ x: x * radians, y: y * radians, z: z * radians })),
  }))
}
