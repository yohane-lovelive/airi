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

/**
 * The frame policies of the ADR. Replay evaluation compares them, and a developer setting chooses one.
 *
 * - `fresh-keyframes`: the newest frame at full size, and a few smaller key frames.
 * - `contact-sheet`: several reduced frames as tiles of one image. The budget counts one image.
 * - `scene-anchor`: one anchor frame for each scene at a fixed place of the request, then the newest frames.
 * - `scene-anchor+contact-sheet`: the anchor, then one contact sheet.
 */
export const FRAME_POLICY_NAMES = ['fresh-keyframes', 'contact-sheet', 'scene-anchor', 'scene-anchor+contact-sheet'] as const

export type FramePolicyName = typeof FRAME_POLICY_NAMES[number]

/** Limits of the contact sheet and the scene anchor. */
export const CONTACT_SHEET_LIMITS = {
  maxTiles: 6,
  /** Each tile keeps the 16 by 9 shape of a screen. Three tiles fit the width of a full frame. */
  tileWidth: 426,
  tileHeight: 240,
  columns: 3,
} as const

/** Where each tile of a contact sheet goes, and the size of the sheet. */
export interface ContactSheetLayout {
  readonly width: number
  readonly height: number
  readonly tiles: readonly { readonly x: number, readonly y: number, readonly width: number, readonly height: number }[]
}

/**
 * The layout of a contact sheet of `count` tiles: up to three in a row, oldest at the top left.
 *
 * @example
 * contactSheetLayout(6)
 * // => { width: 1278, height: 480, tiles: [{ x: 0, y: 0, width: 426, height: 240 }, ...] }
 */
export function contactSheetLayout(count: number): ContactSheetLayout {
  const { tileWidth, tileHeight, columns: maxColumns } = CONTACT_SHEET_LIMITS
  const tiles = Math.max(0, Math.min(CONTACT_SHEET_LIMITS.maxTiles, Math.floor(count)))
  const columns = Math.max(1, Math.min(maxColumns, tiles))
  const rows = Math.max(1, Math.ceil(tiles / columns))
  return {
    width: columns * tileWidth,
    height: rows * tileHeight,
    tiles: Array.from({ length: tiles }, (_, index) => ({ x: (index % columns) * tileWidth, y: Math.floor(index / columns) * tileHeight, width: tileWidth, height: tileHeight })),
  }
}

/**
 * The frames of a contact sheet: the picks of `fresh-keyframes`, then frames spread over the time since the last turn,
 * so the sheet shows how the screen went. Returns them oldest first.
 */
export function pickContactSheet(input: Omit<FramePolicyInput, 'maxImages'> & { maxTiles?: number }): PickedFrame[] {
  const maxTiles = Math.min(CONTACT_SHEET_LIMITS.maxTiles, input.maxTiles ?? CONTACT_SHEET_LIMITS.maxTiles)
  const picked = pickFreshKeyframes({ ...input, maxImages: maxTiles })
  const recent = input.frames.map((frame, index) => ({ frame, index })).filter(entry => entry.frame.at > input.since && !picked.some(pick => pick.index === entry.index))
  const free = maxTiles - picked.length
  for (let step = 0; step < free && recent.length; step++) {
    // Spread the extra tiles evenly over the frames that are left.
    const entry = recent[Math.floor((step + 0.5) * recent.length / free)]
    if (entry && !picked.some(pick => pick.index === entry.index))
      picked.push({ index: entry.index, role: 'change' })
  }
  return picked.sort((left, right) => left.index - right.index)
}

/**
 * The time of the anchor frame of the current scene: the first frame at or after the newest scene change or app switch.
 * Before any such event, the anchor stays `previous`, or it starts at the newest frame. Returns `undefined` without
 * frames.
 */
export function sceneAnchorAt(input: { frames: readonly PolicyFrame[], boundaries: readonly number[], previous?: number }): number | undefined {
  const newestFrame = input.frames.at(-1)
  if (!newestFrame)
    return input.previous
  const boundary = Math.max(-Infinity, ...input.boundaries)
  if (!Number.isFinite(boundary) || (input.previous !== undefined && input.previous >= boundary))
    return input.previous ?? newestFrame.at
  return input.frames.find(frame => frame.at >= boundary)?.at ?? newestFrame.at
}
