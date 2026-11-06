import type { BodyMotionPose } from '@proj-airi/stage-shared/body-motion'
import type { CharacterFrame } from '@proj-airi/stage-shared/stage-sidecar'

import { ProceduralBodyMotion } from '@proj-airi/stage-shared/body-motion'

import { Ticker } from '../workers/ticker'

const FRAME_INTERVAL_MS = 1000 / 30

/** A long gap, for example after the system sleeps, must not move the procedural layer in one step. */
const MAX_DELTA_SECONDS = 0.25

const REST_ROTATION = Object.freeze({ x: 0, y: 0, z: 0 })

/** The pose while the owner keeps natural movement off. The sidecar still gets frames, because it needs the mouth. */
const REST_POSE: BodyMotionPose = Object.freeze({
  bones: Object.freeze({
    spine: REST_ROTATION,
    chest: REST_ROTATION,
    neck: REST_ROTATION,
    head: REST_ROTATION,
  }),
  eyes: Object.freeze({ yaw: 0, pitch: 0 }),
})

export interface CharacterFrameStreamOptions {
  /** The vowel weights of this moment. The caller reads them from the speech. */
  readMouth: (deltaSeconds: number) => CharacterFrame['mouth']
  /** The loudness of the speech, from 0 to 1. The nods follow it. */
  readSpeechLevel: () => number
  /** Whether the chat model writes a reply. The gaze moves away during this time. */
  isThinking: () => boolean
  /** Whether the owner keeps natural movement on. */
  isBodyMotionEnabled: () => boolean
  send: (frame: CharacterFrame) => void
}

/**
 * Sends the continuous state of the character to a sidecar, 30 times each second.
 *
 * The state comes from the renderer, because the speech and the procedural layer live there. The sidecar only applies
 * it. The ticks come from {@link Ticker}, so a hidden window keeps the stream alive. If the stream stops, the sidecar
 * fades the mouth and the offsets by itself.
 *
 * Lifecycle: `start` starts the ticks and does nothing while they run. `stop` ends them. The owner of the instance calls
 * `stop` when it no longer draws through a sidecar.
 */
export class CharacterFrameStream {
  private readonly motion = new ProceduralBodyMotion()
  private readonly ticker = new Ticker(FRAME_INTERVAL_MS, () => this.tick())
  private lastTickAt = 0

  constructor(private readonly options: CharacterFrameStreamOptions) {}

  start() {
    this.lastTickAt = performance.now()
    this.ticker.start()
  }

  stop() {
    this.ticker.stop()
  }

  private tick() {
    const now = performance.now()
    const deltaSeconds = Math.min((now - this.lastTickAt) / 1000, MAX_DELTA_SECONDS)
    this.lastTickAt = now

    const pose = this.options.isBodyMotionEnabled()
      ? this.motion.update(deltaSeconds, { thinking: this.options.isThinking(), speechLevel: this.options.readSpeechLevel() })
      : REST_POSE

    this.options.send({
      mouth: this.options.readMouth(deltaSeconds),
      bones: pose.bones,
      eyes: pose.eyes,
    })
  }
}
