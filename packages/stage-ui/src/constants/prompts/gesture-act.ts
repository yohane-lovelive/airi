/** The most gestures that the prompt lists. */
export const GESTURE_PROMPT_LIMIT = 15

/** A clip of the motion library, as the prompt lists it. */
export interface GesturePromptEntry {
  name: string
  description: string
  useCount: number
  enabled: boolean
}

/**
 * Builds the ACT instructions for the gestures of a VRM or MMD model.
 *
 * With more enabled clips than {@link GESTURE_PROMPT_LIMIT}, the most used ones are listed. The list keeps the order of
 * the library, so the prompt changes only when a clip joins or leaves it, and the cached prefix stays.
 *
 * Returns:
 * - The prompt part, or an empty text without an enabled clip.
 */
export function formatGestureActPrompt(entries: readonly GesturePromptEntry[]): string {
  const enabled = entries.filter(entry => entry.enabled)
  if (enabled.length === 0)
    return ''

  const chosen = new Set(enabled.length > GESTURE_PROMPT_LIMIT
    ? [...enabled].sort((left, right) => right.useCount - left.useCount).slice(0, GESTURE_PROMPT_LIMIT)
    : enabled)
  const listed = enabled.filter(entry => chosen.has(entry))
  const example = JSON.stringify(listed[0].name)

  return [
    'Gestures for the current model:',
    `Write the name of one gesture as the motion of an ACT token, for example <|ACT {"emotion":"happy","motion":${example}}|>. Leave the motion out when no gesture fits. The expression of the emotion lasts as long as the gesture.`,
    'Available gestures:',
    listed.map(entry => `- ${JSON.stringify(entry.name)}: ${entry.description}`).join('\n'),
  ].join('\n\n')
}
