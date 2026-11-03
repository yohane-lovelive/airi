import type { TurnNext } from './initiative'

const NEXT_MARKER = /^<\|NEXT\s+(continue|wait|done)\s*\|>$/i

/**
 * Reads a `<|NEXT ...|>` marker. Returns `undefined` for another marker or an unknown value.
 *
 * @example
 * nextFromMarker('<|NEXT wait|>')
 * // => 'wait'
 */
export function nextFromMarker(special: string): TurnNext | undefined {
  const value = NEXT_MARKER.exec(special.trim())?.[1]?.toLowerCase()
  return value === 'continue' || value === 'wait' || value === 'done' ? value : undefined
}
