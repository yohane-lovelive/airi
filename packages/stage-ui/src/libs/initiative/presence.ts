/** The times of the daily rhythm: when the owner counts as away, back, or new to the day. */
export const OWNER_PRESENCE_LIMITS = {
  /** No input for this long makes the owner away. */
  awayAfterMs: 10 * 60_000,
  /** A return after this long away gets a welcome back. */
  welcomeBackAfterMs: 30 * 60_000,
  /** The runner reads the idle time this often. */
  pollMs: 15_000,
  /** At app start, a conversation quiet for this long gets a greeting. */
  greetingAfterMs: 3 * 60 * 60_000,
  /** A greeting or a welcome back that cannot start within this time is dropped. It is about this moment only. */
  rhythmHoldMs: 2 * 60_000,
  /** No welcome back follows a greeting or a welcome back within this time. */
  rhythmGapMs: 10 * 60_000,
}

/**
 * Where the runner reads whether the owner is at the device. Each app gives its own source.
 *
 * - The desktop app reads the system idle time, and the screen lock and sleep events.
 * - The web app reads the input and the visibility of the page.
 */
export interface OwnerPresenceSource {
  /** Milliseconds since the last input of the owner. */
  idleMs: () => Promise<number>
  /** Calls `listener` when the owner surely left, for example at a screen lock. Returns a function that stops it. */
  onAway?: (listener: () => void) => () => void
}

/** Whether the owner is away. `awaySince` is the time of the last input before the owner left. */
export interface OwnerPresence {
  awaySince?: number
}

/**
 * Applies one idle reading. A long idle time makes the owner away. A short one after that means that the owner came
 * back, and `returnedAfterMs` tells how long the owner was away.
 */
export function observePresence(presence: OwnerPresence, idleMs: number, now: number): { presence: OwnerPresence, returnedAfterMs?: number } {
  if (idleMs >= OWNER_PRESENCE_LIMITS.awayAfterMs)
    return { presence: { awaySince: presence.awaySince ?? now - idleMs } }
  if (presence.awaySince === undefined)
    return { presence }
  return { presence: {}, returnedAfterMs: Math.max(0, now - idleMs - presence.awaySince) }
}

/** Marks the owner away now, for example at a screen lock. An earlier start of the absence stays. */
export function markAway(presence: OwnerPresence, now: number): OwnerPresence {
  return { awaySince: presence.awaySince ?? now }
}

/** Whether the app start gets a greeting: the open conversation is new, or quiet for a long time. */
export function shouldGreet(lastMessageAt: number | undefined, now: number) {
  return lastMessageAt === undefined || now - lastMessageAt >= OWNER_PRESENCE_LIMITS.greetingAfterMs
}
