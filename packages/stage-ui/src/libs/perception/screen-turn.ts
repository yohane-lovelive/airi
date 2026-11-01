import type { ChatAttachment, InitiativeScreenContext } from '@proj-airi/core-agent'
import type { ScreenEvent } from '@proj-airi/stage-shared/perception'

import type { CapturedFrame } from './frame-ring'
import type { ImageBudgetState } from './image-budget'

import { encodeBase64 } from '@moeru/std/base64'
import { pickFreshKeyframes } from '@proj-airi/stage-shared/perception'

import { scaleImage } from './encode-frame'
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
  /** The time of the last turn with the screen. Frames and events after it are news. */
  readonly since: number
  readonly now: number
}

/** The screen part of one decision turn: the situation lines, the frames to attach, and their count for the budget. */
export interface ScreenTurn {
  readonly context: InitiativeScreenContext
  readonly attachments: ChatAttachment[]
}

async function attachmentOf(image: Blob): Promise<ChatAttachment> {
  return { type: 'image', mimeType: 'image/jpeg', data: encodeBase64(new Uint8Array(await image.arrayBuffer())) }
}

/**
 * Builds the screen part of one decision turn with the `fresh-keyframes` policy.
 *
 * - The image budget sets how many frames go: up to three, the newest only when it runs low, none when it is empty.
 * - The newest frame goes at full size. Older frames go smaller, so they cost fewer tokens.
 * - The situation lines tell the age of each frame, the app in front, and the events since the last turn.
 *
 * Use when:
 * - The initiative runner starts a decision turn while screen perception runs.
 */
export async function buildScreenTurn(input: ScreenTurnInput): Promise<ScreenTurn> {
  const count = imagesForTurn(input.budget)
  const fresh = input.events.filter(event => event.at > input.since)
  const picks = pickFreshKeyframes({ frames: input.frames, eventTimes: fresh.map(event => event.at), since: input.since, maxImages: count })
  const attachments = await Promise.all(picks.map(async ({ index, role }) => {
    const frame = input.frames[index]
    return attachmentOf(role === 'newest' ? frame.image : await scaleImage(frame.image, FRAME_LIMITS.smallLongSide))
  }))
  return {
    context: {
      ...(input.app ? { app: input.app } : {}),
      frameAgesMs: picks.map(({ index }) => Math.max(0, input.now - input.frames[index].at)),
      ...(count === 0 && input.budget.remaining <= 0 ? { blind: 'budget' as const } : {}),
      events: fresh.map(event => ({ type: event.type, ageMs: Math.max(0, input.now - event.at), ...(event.app ? { app: event.app } : {}) })),
    },
    attachments,
  }
}
