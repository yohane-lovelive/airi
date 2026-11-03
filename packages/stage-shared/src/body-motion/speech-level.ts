/** The RMS of normal speech is about 0.1 to 0.3, so this gain puts loud syllables near 1. */
const LEVEL_GAIN = 4

/**
 * Measures the loudness of the speech of the character, for the nods of {@link ProceduralBodyMotion}.
 *
 * The meter listens to an audio source beside its other outputs, so the playback does not change.
 *
 * Use when:
 * - A model renderer gets the `AudioBufferSourceNode` of the current speech.
 */
export class SpeechLevelMeter {
  private readonly analyser: AnalyserNode
  private readonly samples: Float32Array<ArrayBuffer>
  private source: AudioNode | undefined

  constructor(context: AudioContext) {
    this.analyser = context.createAnalyser()
    this.analyser.fftSize = 512
    this.samples = new Float32Array(this.analyser.fftSize)
  }

  /** Listens to `source`, or to nothing. */
  listen(source: AudioNode | undefined) {
    if (this.source === source)
      return
    try {
      this.source?.disconnect(this.analyser)
    }
    catch {
      // The source already ended and lost its connections.
    }
    this.source = source
    source?.connect(this.analyser)
  }

  /** The loudness of the last 512 samples, from 0 to 1. */
  read() {
    if (!this.source)
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
