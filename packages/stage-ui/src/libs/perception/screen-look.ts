import type { DecisionModelInput, DecisionModelResult } from '@proj-airi/core-agent'

import type { CapturedFrame } from './frame-ring'

import { errorMessageFrom } from '@moeru/std'
import { encodeBase64 } from '@moeru/std/base64'
import { DecisionRequestError, SCREEN_GATE, SCREEN_LOOK_QUESTIONS, screenGateInput } from '@proj-airi/core-agent'

/** Limits of the screen look. */
export const SCREEN_LOOK_LIMITS = {
  /** Two frames further apart than this are no pair. The capture stopped between them, so the look starts again. */
  maxFrameGapMs: 3 * SCREEN_GATE.stepMs,
  /** The rest after the server answered 429. The free tier counts the input tokens of one minute. */
  rateLimitRestMs: 20_000,
  /** The rest after another failure, for example a key that the server refuses. */
  failureRestMs: 60_000,
} as const

/** What the decision model answered for one look. The chances are from 0 to 1. */
export interface ScreenLookResult {
  /** The time of the current frame of the look. */
  readonly at: number
  /** The chance that the frame shows a moment to react to. */
  readonly react: number
  /** The chance that the frame shows a roster screen. */
  readonly roster: number
  /** The chance that the list of the frame is a table of icons, which a cast read cannot copy. */
  readonly iconList: number
  readonly inputTokens: number
}

/** Asks the decision model the questions of one look. The decision model store gives it. */
export type ScreenLookDecide = (input: readonly DecisionModelInput[], questions: typeof SCREEN_LOOK_QUESTIONS, signal?: AbortSignal) => Promise<DecisionModelResult<typeof SCREEN_LOOK_QUESTIONS>>

async function base64Of(image: Blob) {
  return encodeBase64(new Uint8Array(await image.arrayBuffer()))
}

/**
 * Looks at the screen with the decision model: one request for each call, about the frame of the call before and the
 * newest frame.
 *
 * Use when:
 * - A host calls `look` once each {@link SCREEN_GATE.stepMs} while a commentary watches its window.
 *
 * Expects:
 * - The caller gives the newest frame of the ring. The look keeps the frame of the call before.
 *
 * Returns:
 * - The chances of one look, or `undefined` when no request ran: the first call, no new frame, a request in flight,
 *   or the rest after a failure. A failed request logs a warning and starts a rest, so a wrong key does not send a
 *   request each step.
 */
export class ScreenLook {
  private previous?: CapturedFrame
  private busy = false
  private restUntil = 0

  constructor(private readonly decide: ScreenLookDecide) {}

  async look(newest: CapturedFrame | undefined, now: number): Promise<ScreenLookResult | undefined> {
    if (!newest || this.busy || now < this.restUntil)
      return undefined
    const previous = this.previous
    this.previous = newest
    if (!previous || newest.at <= previous.at || newest.at - previous.at > SCREEN_LOOK_LIMITS.maxFrameGapMs)
      return undefined

    this.busy = true
    try {
      const result = await this.decide(screenGateInput(await base64Of(previous.image), await base64Of(newest.image)), SCREEN_LOOK_QUESTIONS)
      return { at: newest.at, react: result.answers.react.probability, roster: result.answers.roster.probability, iconList: result.answers.iconList.probability, inputTokens: result.inputTokens }
    }
    catch (error) {
      const rateLimited = error instanceof DecisionRequestError && error.status === 429
      this.restUntil = now + (rateLimited ? SCREEN_LOOK_LIMITS.rateLimitRestMs : SCREEN_LOOK_LIMITS.failureRestMs)
      console.warn('[perception] A screen look failed:', errorMessageFrom(error))
      return undefined
    }
    finally {
      this.busy = false
    }
  }

  /** Forgets the frame of the call before, for example when the commentary ends. The next call starts a new pair. */
  reset() {
    this.previous = undefined
  }
}
