/** One captured frame. It lives in memory only and never reaches the disk. */
export interface CapturedFrame {
  /** Epoch milliseconds of the capture. */
  readonly at: number
  /** The frame as JPEG, at most {@link FRAME_LIMITS.maxLongSide} pixels on its long side. */
  readonly image: Blob
  readonly width: number
  readonly height: number
  /** A grayscale copy of {@link FRAME_LIMITS.thumbnailWidth} by {@link FRAME_LIMITS.thumbnailHeight} pixels, one byte for each pixel. The detectors compare it. */
  readonly thumbnail: Uint8Array
}

/** Limits of captured frames and of the ring that holds them. */
export const FRAME_LIMITS = {
  /** The capture takes a frame this often: 2 frames each second. */
  intervalMs: 500,
  /** The ring holds the frames of this time, counted back from the newest frame. */
  maxAgeMs: 60_000,
  /** The ring holds this many frames at most, also when frames come faster than the interval. */
  maxFrames: 120,
  /** A frame is scaled down to this many pixels on its long side. A larger frame costs more tokens and memory. */
  maxLongSide: 1280,
  /** A decision turn sends the frames other than the newest one at this size. */
  smallLongSide: 512,
  jpegQuality: 0.75,
  thumbnailWidth: 64,
  thumbnailHeight: 36,
} as const

/**
 * The frames of the last minute, oldest first.
 *
 * Use when:
 * - The perception runner keeps the recent screen. The detectors and the decision turn read it.
 *
 * Expects:
 * - Frames come in time order. A push drops the frames that are older than the age limit, counted from the new frame.
 */
export class FrameRing {
  private entries: CapturedFrame[] = []

  push(frame: CapturedFrame) {
    this.entries.push(frame)
    const oldest = frame.at - FRAME_LIMITS.maxAgeMs
    const firstKept = this.entries.findIndex(entry => entry.at > oldest)
    if (firstKept > 0)
      this.entries.splice(0, firstKept)
    if (this.entries.length > FRAME_LIMITS.maxFrames)
      this.entries.splice(0, this.entries.length - FRAME_LIMITS.maxFrames)
  }

  /** The frames, oldest first. */
  frames(): readonly CapturedFrame[] {
    return this.entries
  }

  latest(): CapturedFrame | undefined {
    return this.entries.at(-1)
  }

  get size() {
    return this.entries.length
  }

  /** The bytes of all JPEG images. The thumbnails add a few kilobytes. */
  get bytes() {
    return this.entries.reduce((sum, entry) => sum + entry.image.size, 0)
  }

  /** Drops every frame, for example when perception pauses. */
  clear() {
    this.entries = []
  }
}
