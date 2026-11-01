/**
 * After the last input, the owner counts as typing for at least this long. A short pause to think is still typing.
 * The stored end is `OWNER_TYPING_REFRESH_MS` longer, so the hold stays at least this long between refreshes.
 */
export const OWNER_TYPING_MIN_HOLD_MS = 15_000
/** A window writes the shared typing end at most this often, so each key press does not replicate the store. */
export const OWNER_TYPING_REFRESH_MS = 5_000

const OWNER_TYPING_HOLD_MS = OWNER_TYPING_MIN_HOLD_MS + OWNER_TYPING_REFRESH_MS

/**
 * Finds the new end of the typing window after an input at `now`.
 *
 * Returns:
 * - The new end in epoch milliseconds.
 * - `undefined` when the stored end is still recent enough, so the caller writes nothing.
 */
export function nextOwnerTypingUntil(storedUntil: number, now: number): number | undefined {
  if (storedUntil - now > OWNER_TYPING_MIN_HOLD_MS)
    return undefined
  return now + OWNER_TYPING_HOLD_MS
}

/** Whether the owner counts as typing at `now`. */
export function isOwnerTyping(typingUntil: number, now: number): boolean {
  return now < typingUntil
}
