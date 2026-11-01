import { thumbnailDiff } from './detectors'

/** One frame as a frame policy sees it: its time and its grayscale thumbnail. */
export interface PolicyFrame {
  readonly at: number
  readonly thumbnail: Uint8Array
}

/**
 * Why a policy picked a frame.
 *
 * - `newest`: the screen now. It goes at full size.
 * - `before-event`: the screen before an event, so a late reaction still sees the cause.
 * - `change`: a frame that changed much since the last turn.
 */
export type PickedFrameRole = 'newest' | 'before-event' | 'change'

export interface PickedFrame {
  /** The index in the frames that the policy got. */
  readonly index: number
  readonly role: PickedFrameRole
}

/** What a frame policy reads at one decision turn. */
export interface FramePolicyInput {
  /** The frames of the ring, oldest first. */
  readonly frames: readonly PolicyFrame[]
  /** The times of the screen events since the last turn. */
  readonly eventTimes: readonly number[]
  /** The time of the last turn. Only later frames count as news. */
  readonly since: number
  /** The most frames to pick. The image budget sets it. */
  readonly maxImages: number
}

/** Limits of `fresh-keyframes`. */
export const FRESH_KEYFRAME_LIMITS = {
  /** The policy looks this far back from an event for the change that caused it. */
  eventLookbackMs: 5_000,
  /** A picked frame must differ from the frames picked before it by this much, so two picks do not show the same. */
  minDistinctDiff: 0.02,
} as const

/**
 * The `fresh-keyframes` frame policy of the ADR: the newest frame, the frame before each event, and the frames that
 * changed most since the last turn. Returns the picks oldest first, so the newest frame comes last.
 *
 * @example
 * pickFreshKeyframes({ frames, eventTimes: [], since: 0, maxImages: 1 })
 * // => [{ index: frames.length - 1, role: 'newest' }]
 */
export function pickFreshKeyframes(input: FramePolicyInput): PickedFrame[] {
  const { frames, maxImages } = input
  if (!frames.length || maxImages < 1)
    return []
  const newest = frames.length - 1
  const picked: PickedFrame[] = [{ index: newest, role: 'newest' }]
  const distinct = (index: number) => picked.every(pick => thumbnailDiff(frames[pick.index].thumbnail, frames[index].thumbnail) >= FRESH_KEYFRAME_LIMITS.minDistinctDiff)
  const jumpAt = (index: number) => index > 0 ? thumbnailDiff(frames[index - 1].thumbnail, frames[index].thumbnail) : 0

  // The frame before the largest jump near each event shows the screen before the cause. The newest events come first.
  for (const eventAt of [...input.eventTimes].sort((left, right) => right - left)) {
    if (picked.length >= maxImages)
      break
    let jump = -1
    let largest = 0
    for (let index = 1; index < frames.length; index++) {
      const at = frames[index].at
      if (at > eventAt || at < eventAt - FRESH_KEYFRAME_LIMITS.eventLookbackMs || at <= input.since)
        continue
      const size = jumpAt(index)
      if (size > largest) {
        largest = size
        jump = index
      }
    }
    const before = jump - 1
    if (before >= 0 && !picked.some(pick => pick.index === before) && distinct(before))
      picked.push({ index: before, role: 'before-event' })
  }

  // The rest goes to the frames that changed most since the last turn.
  const changes = frames
    .map((frame, index) => ({ index, at: frame.at, size: jumpAt(index) }))
    .filter(entry => entry.at > input.since && entry.index !== newest && entry.size > 0)
    .sort((left, right) => right.size - left.size)
  for (const change of changes) {
    if (picked.length >= maxImages)
      break
    if (!picked.some(pick => pick.index === change.index) && distinct(change.index))
      picked.push({ index: change.index, role: 'change' })
  }

  return picked.sort((left, right) => left.index - right.index)
}
