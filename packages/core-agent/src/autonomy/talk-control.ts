/**
 * A talk level request from the owner, as a tool gives it.
 *
 * - `quiet`: no autonomous speech for `minutes`.
 * - `less` or `more`: a longer or a shorter talk interval. `minutes` above 0 makes the change temporary. 0 makes it
 *   permanent, so the host changes the stored interval.
 * - `normal`: ends every temporary change.
 */
export type TalkLevelRequest
  = | { readonly kind: 'quiet', readonly minutes: number }
    | { readonly kind: 'less' | 'more', readonly minutes: number }
    | { readonly kind: 'normal' }

/** The temporary changes that the owner asked for. Each part has an end time. The host stores it. */
export interface TalkControl {
  /** Epoch milliseconds. No autonomous speech until this time. */
  readonly quietUntil?: number
  /** The idle talk interval is multiplied by `factor` until `until`. */
  readonly interval?: { readonly factor: number, readonly until: number }
}

/** Limits of talk level requests. */
export const TALK_CONTROL_LIMITS = {
  /** 12 hours. A longer quiet is the switch in Settings. */
  maxMinutes: 720,
  lessFactor: 1.5,
  moreFactor: 2 / 3,
} as const

const MINUTE_MS = 60_000

/** The result of a request. `permanentFactor` asks the host to multiply the stored idle interval by it. */
export type TalkLevelResult
  = | { readonly ok: true, readonly control: TalkControl, readonly permanentFactor?: number }
    | { readonly ok: false, readonly reason: string }

/** Drops the parts that ended at `now`. */
export function activeTalkControl(control: TalkControl, now: number): TalkControl {
  return {
    ...(control.quietUntil !== undefined && control.quietUntil > now ? { quietUntil: control.quietUntil } : {}),
    ...(control.interval && control.interval.until > now ? { interval: control.interval } : {}),
  }
}

/**
 * Applies one talk level request. On a refusal, `reason` tells the model what to change.
 * A new temporary interval replaces the earlier one, so "talk less" twice does not stack.
 *
 * @example
 * applyTalkLevel({}, { kind: 'quiet', minutes: 30 }, 0)
 * // => { ok: true, control: { quietUntil: 1800000 } }
 */
export function applyTalkLevel(control: TalkControl, request: TalkLevelRequest, now: number): TalkLevelResult {
  const current = activeTalkControl(control, now)
  if (request.kind === 'normal')
    return { ok: true, control: {} }

  const { minutes } = request
  const maxMinutes = TALK_CONTROL_LIMITS.maxMinutes
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > maxMinutes)
    return { ok: false, reason: `The minutes must be a whole number from 0 to ${maxMinutes}.` }

  if (request.kind === 'quiet') {
    if (minutes === 0)
      return { ok: false, reason: `Quiet needs a time from 1 to ${maxMinutes} minutes.` }
    return { ok: true, control: { ...current, quietUntil: now + minutes * MINUTE_MS } }
  }

  const factor = request.kind === 'less' ? TALK_CONTROL_LIMITS.lessFactor : TALK_CONTROL_LIMITS.moreFactor
  // "Talk more" also ends a quiet time.
  const quietUntil = request.kind === 'less' ? current.quietUntil : undefined
  const quiet = quietUntil !== undefined ? { quietUntil } : {}
  // A permanent change replaces a temporary one, so the two do not stack.
  if (minutes === 0)
    return { ok: true, control: quiet, permanentFactor: factor }
  return { ok: true, control: { ...quiet, interval: { factor, until: now + minutes * MINUTE_MS } } }
}

/**
 * What the active control changes in the policy at `now`.
 *
 * Returns:
 * - `quietUntil` while a quiet time runs.
 * - `idleIntervalFactor`, the multiplier of the idle talk interval. It is 1 without a temporary change.
 */
export function talkControlEffect(control: TalkControl, now: number): { quietUntil?: number, idleIntervalFactor: number } {
  const active = activeTalkControl(control, now)
  return {
    ...(active.quietUntil !== undefined ? { quietUntil: active.quietUntil } : {}),
    idleIntervalFactor: active.interval?.factor ?? 1,
  }
}
