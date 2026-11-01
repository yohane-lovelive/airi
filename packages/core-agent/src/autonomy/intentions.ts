/**
 * Something that the character wants to do later, for example "ask the owner about the trip".
 * The model writes it with a tool. Code limits the count and gives each one an end time.
 */
export interface Intention {
  readonly id: string
  /** A short note in the words of the character. */
  readonly text: string
  /** Epoch milliseconds. */
  readonly createdAt: number
  /** Epoch milliseconds. After this time, the intention is gone. */
  readonly expiresAt: number
}

/** An intention, as the model asks for it. */
export interface IntentionRequest {
  readonly text: string
  /** How long the intention stays, in hours. */
  readonly hours: number
}

/** Limits of intentions. The tools describe them to the model. */
export const INTENTION_LIMITS = {
  /** The maximum count of open intentions. More would turn every turn into a to-do list. */
  maxOpen: 5,
  maxTextLength: 120,
  minHours: 1,
  /** One week. A wish older than this is stale. */
  maxHours: 168,
  defaultHours: 24,
} as const

const HOUR_MS = 60 * 60_000

/** The intentions that are still open at `now`, oldest first. */
export function openIntentions(intentions: readonly Intention[], now: number): Intention[] {
  return intentions.filter(intention => intention.expiresAt > now).sort((left, right) => left.createdAt - right.createdAt)
}

/**
 * Creates an intention from the request that the model gave. On a refusal, `reason` tells the model what to change.
 *
 * @example
 * createIntention({ id: 'a', request: { text: 'Ask about the trip', hours: 24 }, now: 0, open: [] })
 * // => { ok: true, intention: { id: 'a', text: 'Ask about the trip', createdAt: 0, expiresAt: 86400000 } }
 */
export function createIntention(input: { id: string, request: IntentionRequest, now: number, open: readonly Intention[] }): { ok: true, intention: Intention } | { ok: false, reason: string } {
  const text = input.request.text.trim().replace(/\s+/g, ' ')
  if (!text)
    return { ok: false, reason: 'The text is empty. Write what you want to do later.' }
  if (text.length > INTENTION_LIMITS.maxTextLength)
    return { ok: false, reason: `The text is longer than ${INTENTION_LIMITS.maxTextLength} characters. Make it shorter.` }
  const { hours } = input.request
  if (!Number.isFinite(hours) || hours < INTENTION_LIMITS.minHours || hours > INTENTION_LIMITS.maxHours)
    return { ok: false, reason: `The hours must be from ${INTENTION_LIMITS.minHours} to ${INTENTION_LIMITS.maxHours}.` }
  const open = openIntentions(input.open, input.now)
  if (open.length >= INTENTION_LIMITS.maxOpen)
    return { ok: false, reason: `You already have ${INTENTION_LIMITS.maxOpen} intentions. Finish one first.` }
  return { ok: true, intention: { id: input.id, text, createdAt: input.now, expiresAt: input.now + hours * HOUR_MS } }
}
