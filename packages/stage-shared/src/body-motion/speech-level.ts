/** The RMS of normal speech is about 0.1 to 0.3, so this gain puts loud syllables near 1. */
const LEVEL_GAIN = 4

/** Connects a node to the played speech and returns the disconnection. */
export type SpeechConnector = (node: AudioNode) => () => void

/**
 * Measures the loudness of the speech of the character, for the nods of {@link ProceduralBodyMotion}.
 *
 * The meter listens to the played speech beside its other outputs, so the playback does not change.
 *
 * Use when:
 * - A model renderer gets a function that connects a node to the played speech.
 */
export class SpeechLevelMeter {
  private readonly analyser: AnalyserNode
  private readonly samples: Float32Array<ArrayBuffer>
  private connect: SpeechConnector | undefined
  private disconnect: (() => void) | undefined

  constructor(context: AudioContext) {
    this.analyser = context.createAnalyser()
    this.analyser.fftSize = 512
    this.samples = new Float32Array(this.analyser.fftSize)
  }

  /** Listens to the speech that `connect` plays, or to nothing. */
  listen(connect: SpeechConnector | undefined) {
    if (this.connect === connect)
      return
    this.disconnect?.()
    this.connect = connect
    this.disconnect = connect?.(this.analyser)
  }

  /** The loudness of the last 512 samples, from 0 to 1. */
  read() {
    if (!this.connect)
      return 0
    this.analyser.getFloatTimeDomainData(this.samples)
    let sum = 0
    for (const sample of this.samples)
      sum += sample * sample
    return Math.min(1, Math.sqrt(sum / this.samples.length) * LEVEL_GAIN)
  }

  dispose() {
    this.listen(undefined)
  }
}
