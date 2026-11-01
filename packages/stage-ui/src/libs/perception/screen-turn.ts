import type { ChatAttachment, InitiativeScreenContext } from '@proj-airi/core-agent'
import type { FramePolicyName, ScreenEvent } from '@proj-airi/stage-shared/perception'

import type { CapturedFrame } from './frame-ring'
import type { ImageBudgetState } from './image-budget'

import { encodeBase64 } from '@moeru/std/base64'
import { SCENE_ANCHOR_TEXT } from '@proj-airi/core-agent'
import { pickContactSheet, pickFreshKeyframes } from '@proj-airi/stage-shared/perception'

import { renderContactSheet, scaleImage } from './encode-frame'
import { FRAME_LIMITS } from './frame-ring'
import { imagesForTurn } from './image-budget'

/** What the screen part of one decision turn reads. */
export interface ScreenTurnInput {
  /** The frames of the ring, oldest first. */
  readonly frames: readonly CapturedFrame[]
  /** The recent screen events, oldest first. */
  readonly events: readonly ScreenEvent[]
  /** The app in front, where the device can tell it. */
  readonly app?: string
  readonly budget: ImageBudgetState
  /** The most frames for this turn. Commentary sends fewer. */
  readonly maxImagesPerTurn?: number
  /** The time of the last turn with the screen. Frames and events after it are news. */
  readonly since: number
  readonly now: number
  /** @default 'fresh-keyframes' */
  readonly policy?: FramePolicyName
  /** The anchor frame of the current scene, for the `scene-anchor` policies. The host keeps it across turns. */
  readonly anchor?: CapturedFrame
}

/**
 * The screen part of one decision turn: the situation lines, the frames to attach to the notice, the anchor that goes
 * near the start of the request, and the count of images for the budget.
 */
export interface ScreenTurn {
  readonly context: InitiativeScreenContext
  readonly attachments: ChatAttachment[]
  readonly anchor?: { readonly text: string, readonly image: string }
  readonly images: number
}

async function base64Of(image: Blob) {
  return encodeBase64(new Uint8Array(await image.arrayBuffer()))
}

async function attachmentOf(image: Blob): Promise<ChatAttachment> {
  return { type: 'image', mimeType: 'image/jpeg', data: await base64Of(image) }
}

/**
 * Builds the screen part of one decision turn with a frame policy of the ADR.
 *
 * - The image budget sets how many images go: up to three, two in commentary, one when it runs low, none when empty.
 * - `fresh-keyframes` sends the newest frame at full size and older key frames smaller.
 * - `contact-sheet` sends one image of up to six tiles, so the budget counts one image.
 * - `scene-anchor` puts the anchor frame of the scene near the start of the request and adds the newest frames. With
 *   one image left, the newest frame wins over the anchor.
 * - `scene-anchor+contact-sheet` sends the anchor and one contact sheet. With one image left, the sheet wins.
 *
 * Use when:
 * - The initiative runner starts a decision turn while screen perception runs.
 */
export async function buildScreenTurn(input: ScreenTurnInput): Promise<ScreenTurn> {
  const count = imagesForTurn(input.budget, input.maxImagesPerTurn)
  const policy = input.policy ?? 'fresh-keyframes'
  const fresh = input.events.filter(event => event.at > input.since)
  const eventTimes = fresh.map(event => event.at)
  const withAnchor = Boolean(input.anchor) && count >= 2 && (policy === 'scene-anchor' || policy === 'scene-anchor+contact-sheet')
  const withSheet = count >= 1 && (policy === 'contact-sheet' || policy === 'scene-anchor+contact-sheet')
  const ageOf = (frame: CapturedFrame) => Math.max(0, input.now - frame.at)

  const attachments: ChatAttachment[] = []
  let frameAgesMs: number[] = []
  let contactSheetAgesMs: number[] | undefined
  if (withSheet) {
    const tiles = pickContactSheet({ frames: input.frames, eventTimes, since: input.since }).map(pick => input.frames[pick.index])
    if (tiles.length) {
      attachments.push(await attachmentOf(await renderContactSheet(tiles.map(tile => tile.image))))
      contactSheetAgesMs = tiles.map(ageOf)
    }
  }
  else {
    const picks = pickFreshKeyframes({ frames: input.frames, eventTimes, since: input.since, maxImages: withAnchor ? count - 1 : count })
    for (const { index, role } of picks) {
      const frame = input.frames[index]
      attachments.push(await attachmentOf(role === 'newest' ? frame.image : await scaleImage(frame.image, FRAME_LIMITS.smallLongSide)))
    }
    frameAgesMs = picks.map(({ index }) => ageOf(input.frames[index]))
  }

  const anchor = withAnchor && input.anchor
    ? { text: SCENE_ANCHOR_TEXT, image: `data:image/jpeg;base64,${await base64Of(input.anchor.image)}` }
    : undefined
  return {
    context: {
      ...(input.app ? { app: input.app } : {}),
      frameAgesMs,
      ...(contactSheetAgesMs ? { contactSheetAgesMs } : {}),
      ...(anchor && input.anchor ? { anchorAgeMs: ageOf(input.anchor) } : {}),
      ...(count === 0 && input.budget.remaining <= 0 ? { blind: 'budget' as const } : {}),
      events: fresh.map(event => ({ type: event.type, ageMs: Math.max(0, input.now - event.at), ...(event.app ? { app: event.app } : {}) })),
    },
    attachments,
    ...(anchor ? { anchor } : {}),
    images: attachments.length + (anchor ? 1 : 0),
  }
}
