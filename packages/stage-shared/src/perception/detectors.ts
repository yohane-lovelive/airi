/**
 * Thresholds of the screen detectors. The first values come from synthetic frame streams. Replay evaluation tunes them
 * later.
 */
export const DETECTOR_LIMITS = {
  /** A frame with a mean brightness change below this share of the full range is still. */
  stillDiff: 0.01,
  /**
   * The noise floor follows the frame change of a screen that never stops, for example an animated game lobby. It rises
   * slowly, with this half-life, so a few seconds of scrolling do not raise it much.
   */
  noiseRiseHalfLifeMs: 15_000,
  /** The noise floor falls fast, with this half-life, when the screen calms down. */
  noiseFallHalfLifeMs: 2_000,
  /** A frame is still when its change is below this multiple of the noise floor, or below `stillDiff`. */
  noiseStillFactor: 1.5,
  /** A scene change must be at least this multiple of the noise floor, or `minSceneChange`. */
  noiseSceneFactor: 2,
  /** The screen settles after this many still frames in a row. At 2 frames each second, this is one second. */
  settleFrames: 2,
  /** A settled screen that differs from the last settled screen by less than this is the same scene. */
  minSceneChange: 0.02,
  /** The usual scene change of an app before the detector learns it. */
  initialBaseline: 0.05,
  /** A baseline below this counts as this, so a very calm app does not turn each small change into a large event. */
  baselineFloor: 0.02,
  /** Each scene change moves the baseline of its app by this share. */
  baselineRate: 0.2,
  /** Each recent settled screen leaves one hash. A new screen near one of them is familiar. */
  familiarHashes: 32,
  /** Two hashes with at most this many different bits show the same screen. */
  familiarDistance: 6,
  /** A familiar screen keeps this share of its salience. */
  familiarFactor: 0.3,
  /** An app switch counts after the owner stays in the new app for this time. */
  appDwellMs: 5_000,
  /** The salience of a switch to an ordinary app. */
  appSwitchSalience: 0.5,
  /** The salience of a switch to the desktop, a file manager, or AIRI itself. */
  quietAppSalience: 0.2,
  /** The screen counts as still after it does not change for this time. */
  longStillMs: 3 * 60_000,
  stillSalience: 0.1,
  /** The activity level halves in this time. */
  activityHalfLifeMs: 5_000,
  /** A mean frame change of this size gives the full activity level of 1. */
  fullActivityDiff: 0.05,
} as const

export type DetectorLimits = { -readonly [Key in keyof typeof DETECTOR_LIMITS]: number }

/** Apps that a switch to tells little: the desktop, file managers, and AIRI itself. Names match in lower case. */
const QUIET_APP_WORDS = ['explorer', 'エクスプローラー', 'finder', 'program manager', 'airi']

/** One frame for the detectors: its time, its grayscale thumbnail, and the app in front where the device knows it. */
export interface DetectorFrame {
  readonly at: number
  readonly thumbnail: Uint8Array
  readonly app?: string
}

/**
 * Something that the detectors saw.
 *
 * - `scene-change`: the screen settled into a scene that differs from the last settled scene.
 * - `app-switch`: the owner stayed in another app for the dwell time.
 * - `still`: the screen did not change for a long time.
 *
 * `salience` is 0 to 1. The policy counts it squared, so many small events weigh less than one large event.
 */
export type ScreenEvent
  = | { readonly type: 'scene-change', readonly at: number, readonly salience: number, readonly magnitude: number, readonly familiar: boolean, readonly app?: string }
    | { readonly type: 'app-switch', readonly at: number, readonly salience: number, readonly app: string, readonly from?: string }
    | { readonly type: 'still', readonly at: number, readonly salience: number, readonly app?: string }

/**
 * The mean brightness change between two thumbnails, from 0 to 1.
 *
 * @example
 * thumbnailDiff(new Uint8Array([0, 0]), new Uint8Array([255, 0]))
 * // => 0.5
 */
export function thumbnailDiff(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length)
  if (!length)
    return 0
  let sum = 0
  for (let index = 0; index < length; index++)
    sum += Math.abs(left[index] - right[index])
  return sum / (length * 255)
}

/**
 * The mean brightness change between two thumbnails inside one box, from 0 to 1. The box holds shares of the width and
 * the height, for example the top right third.
 *
 * @example
 * regionDiff(before, after, 64, 36, { x: 2 / 3, y: 0, width: 1 / 3, height: 1 / 3 })
 * // => the change of the top right cell only
 */
export function regionDiff(left: Uint8Array, right: Uint8Array, width: number, height: number, box: { x: number, y: number, width: number, height: number }): number {
  const startX = Math.max(0, Math.floor(box.x * width))
  const startY = Math.max(0, Math.floor(box.y * height))
  const endX = Math.min(width, Math.max(startX + 1, Math.round((box.x + box.width) * width)))
  const endY = Math.min(height, Math.max(startY + 1, Math.round((box.y + box.height) * height)))
  let sum = 0
  let count = 0
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const index = y * width + x
      sum += Math.abs((left[index] ?? 0) - (right[index] ?? 0))
      count += 1
    }
  }
  return count ? sum / (count * 255) : 0
}

/**
 * A 64-bit difference hash of a thumbnail: 9 by 8 block means, one bit for each pair of horizontal neighbors.
 * Near screens give hashes with few different bits, also after small shifts in brightness.
 */
export function differenceHash(thumbnail: Uint8Array, width: number, height: number): Uint8Array {
  const columns = 9
  const rows = 8
  const means = new Float64Array(columns * rows)
  for (let row = 0; row < rows; row++) {
    const top = Math.floor(row * height / rows)
    const bottom = Math.max(top + 1, Math.floor((row + 1) * height / rows))
    for (let column = 0; column < columns; column++) {
      const left = Math.floor(column * width / columns)
      const right = Math.max(left + 1, Math.floor((column + 1) * width / columns))
      let sum = 0
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++)
          sum += thumbnail[y * width + x] ?? 0
      }
      means[row * columns + column] = sum / ((bottom - top) * (right - left))
    }
  }
  const bits = new Uint8Array(64)
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns - 1; column++)
      bits[row * 8 + column] = means[row * columns + column] < means[row * columns + column + 1] ? 1 : 0
  }
  return bits
}

function hammingDistance(left: Uint8Array, right: Uint8Array) {
  let distance = 0
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index])
      distance += 1
  }
  return distance
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

function isQuietApp(app: string) {
  const name = app.toLowerCase()
  return QUIET_APP_WORDS.some(word => name.includes(word))
}

/**
 * Turns a stream of thumbnails into screen events and an activity level. It runs in code, with no model call.
 *
 * The rules keep menus, transitions, and desktop switches from counting as large events:
 * - Settle, then compare: a change counts only after the screen is still again, against the last still screen. A
 *   screen that never stops, for example an animated game lobby, is still when it changes no more than usual.
 * - Familiar screens: a screen near a recent still screen keeps only a small share of its salience.
 * - Baseline for each app: the salience grows with the change over the usual change of the app in front.
 * - App switch dwell: a switch counts after the owner stays in the new app. The screen change of the switch itself
 *   does not count again as a scene change.
 *
 * Use when:
 * - Screen perception has a new frame. Call `observe` with it, and `skip` for a frame that the exclusion list skipped.
 */
export class ScreenDetector {
  private readonly limits: DetectorLimits
  private readonly thumbnailSize: { width: number, height: number }
  private previous?: Uint8Array
  private stillCount = 0
  /** Whether the screen moved since it last settled. */
  private moving = false
  private lastSettled?: Uint8Array
  /** Whether the app in front changed since the screen last settled. The app switch event covers that change. */
  private appChangedSinceSettle = false
  private readonly hashes: Uint8Array[] = []
  private readonly baselines = new Map<string, number>()
  private lastFrameApp?: string
  private stableApp?: string
  private candidate?: { app: string, since: number }
  private lastChangeAt?: number
  private stillReported = false
  private activityLevel = 0
  /** The usual frame change of a screen that never stops. A still screen has 0. */
  private noiseFloor = 0
  private lastAt?: number

  constructor(options: { width: number, height: number, limits?: Partial<DetectorLimits> }) {
    this.thumbnailSize = { width: options.width, height: options.height }
    this.limits = { ...DETECTOR_LIMITS, ...options.limits }
  }

  /** How much the screen moves now, from 0 to 1. Video and action games give high values. */
  get activity() {
    return this.activityLevel
  }

  /** The frame change that a screen makes all the time, for example an animated background. */
  get noise() {
    return this.noiseFloor
  }

  /** Reads one frame. Returns the events that the frame completes, oldest first. */
  observe(frame: DetectorFrame): ScreenEvent[] {
    const events: ScreenEvent[] = []
    const diff = this.previous ? thumbnailDiff(this.previous, frame.thumbnail) : 0
    const elapsed = this.lastAt === undefined ? 0 : Math.max(0, frame.at - this.lastAt)
    this.updateActivity(frame.at, diff)
    // The threshold uses the floor before this frame, so a sudden large change counts as a movement.
    const stillThreshold = Math.max(this.limits.stillDiff, this.noiseFloor * this.limits.noiseStillFactor)
    if (this.previous)
      this.updateNoise(diff, elapsed)
    this.previous = frame.thumbnail
    this.lastChangeAt ??= frame.at

    if (frame.app !== undefined) {
      if (this.lastFrameApp !== undefined && frame.app !== this.lastFrameApp)
        this.appChangedSinceSettle = true
      this.lastFrameApp = frame.app
      const switched = this.trackApp(frame.app, frame.at)
      if (switched)
        events.push(switched)
    }

    if (diff >= stillThreshold) {
      this.moving = true
      this.stillCount = 0
      this.lastChangeAt = frame.at
      this.stillReported = false
    }
    else {
      this.stillCount += 1
    }

    if (!this.lastSettled && this.stillCount >= this.limits.settleFrames) {
      this.settle(frame.thumbnail)
    }
    else if (this.moving && this.stillCount >= this.limits.settleFrames) {
      const change = this.compareSettled(frame)
      if (change)
        events.push(change)
    }

    if (!this.stillReported && frame.at - this.lastChangeAt >= this.limits.longStillMs) {
      this.stillReported = true
      events.push({ type: 'still', at: frame.at, salience: this.limits.stillSalience, ...(this.stableApp ? { app: this.stableApp } : {}) })
    }
    return events
  }

  /**
   * Reads a frame that the exclusion list skipped. The next frames settle again and do not compare with the screen
   * before, so the change around an excluded window never becomes an event. The app of the excluded window stays
   * unknown to the detector.
   */
  skip(at: number) {
    this.previous = undefined
    this.lastSettled = undefined
    this.moving = false
    this.stillCount = 0
    this.appChangedSinceSettle = false
    this.lastChangeAt = at
    this.stillReported = false
    this.candidate = undefined
    this.lastFrameApp = undefined
    this.updateActivity(at, 0)
  }

  private updateNoise(diff: number, elapsed: number) {
    const halfLife = diff > this.noiseFloor ? this.limits.noiseRiseHalfLifeMs : this.limits.noiseFallHalfLifeMs
    const keep = 0.5 ** (elapsed / halfLife)
    this.noiseFloor = this.noiseFloor * keep + diff * (1 - keep)
  }

  private updateActivity(at: number, diff: number) {
    const elapsed = this.lastAt === undefined ? 0 : Math.max(0, at - this.lastAt)
    this.lastAt = at
    const keep = 0.5 ** (elapsed / this.limits.activityHalfLifeMs)
    const level = clamp01(diff / this.limits.fullActivityDiff)
    this.activityLevel = this.activityLevel * keep + level * (1 - keep)
  }

  private settle(thumbnail: Uint8Array) {
    this.lastSettled = thumbnail
    this.moving = false
    this.appChangedSinceSettle = false
    this.remember(differenceHash(thumbnail, this.thumbnailSize.width, this.thumbnailSize.height))
  }

  /** Compares the newly settled screen with the last settled screen. Returns a scene change, if it is one. */
  private compareSettled(frame: DetectorFrame): ScreenEvent | undefined {
    const magnitude = this.lastSettled ? thumbnailDiff(this.lastSettled, frame.thumbnail) : 0
    const appChanged = this.appChangedSinceSettle
    const hash = differenceHash(frame.thumbnail, this.thumbnailSize.width, this.thumbnailSize.height)
    const familiar = this.hashes.some(known => hammingDistance(known, hash) <= this.limits.familiarDistance)
    this.lastSettled = frame.thumbnail
    this.moving = false
    this.appChangedSinceSettle = false
    this.remember(hash)
    if (magnitude < Math.max(this.limits.minSceneChange, this.noiseFloor * this.limits.noiseSceneFactor) || appChanged)
      return undefined

    const key = frame.app ?? ''
    const baseline = this.baselines.get(key) ?? this.limits.initialBaseline
    this.baselines.set(key, baseline + (magnitude - baseline) * this.limits.baselineRate)
    const scale = 3 * Math.max(baseline, this.limits.baselineFloor)
    const salience = clamp01((magnitude - baseline) / scale) * (familiar ? this.limits.familiarFactor : 1)
    return { type: 'scene-change', at: frame.at, salience, magnitude, familiar, ...(frame.app !== undefined ? { app: frame.app } : {}) }
  }

  private remember(hash: Uint8Array) {
    this.hashes.push(hash)
    if (this.hashes.length > this.limits.familiarHashes)
      this.hashes.shift()
  }

  /** Follows the app in front. Returns an app switch after the dwell time. */
  private trackApp(app: string, at: number): ScreenEvent | undefined {
    if (this.stableApp === undefined) {
      this.stableApp = app
      return undefined
    }
    if (app === this.stableApp) {
      this.candidate = undefined
      return undefined
    }
    if (this.candidate?.app !== app) {
      this.candidate = { app, since: at }
      return undefined
    }
    if (at - this.candidate.since < this.limits.appDwellMs)
      return undefined
    const from = this.stableApp
    this.stableApp = app
    this.candidate = undefined
    const salience = isQuietApp(app) ? this.limits.quietAppSalience : this.limits.appSwitchSalience
    return { type: 'app-switch', at, salience, app, from }
  }
}
