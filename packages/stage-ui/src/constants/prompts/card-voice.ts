/** The longest part of examples in a system prompt. Examples past it are left out whole. */
export const CARD_VOICE_LIMITS = {
  maxExampleChars: 1_500,
  maxGreetingChars: 300,
} as const

/** The fields of a card that show how its character talks. */
export interface CardVoice {
  name: string
  /** `greetings[0]` is the first message of the card. */
  greetings?: readonly string[]
  /** Each example is a list of lines that start with `{{char}}:` or `{{user}}:`. */
  messageExample?: readonly (readonly string[])[]
}

function speakerLine(line: string, name: string) {
  return line.replaceAll('{{char}}', name).replaceAll('{{user}}', 'Owner')
}

/**
 * Builds the part of the system prompt that shows how the character talks: the greeting and the example dialogues of
 * the card, as reference text.
 *
 * Use when:
 * - The system prompt of a card is built. A live check on 2026-11-04 found that cards with examples still talked in a
 *   generic voice, because the prompt left these fields out.
 *
 * Expects:
 * - The examples stay text in the system prompt, not messages, so their place in the history does not matter.
 *
 * Returns:
 * - The prompt part, or an empty text when the card has no greeting and no example.
 */
export function formatCardVoicePrompt(card: CardVoice): string {
  const parts: string[] = []
  const greeting = card.greetings?.[0]?.trim()
  if (greeting) {
    const text = greeting.length > CARD_VOICE_LIMITS.maxGreetingChars ? `${greeting.slice(0, CARD_VOICE_LIMITS.maxGreetingChars - 1)}…` : greeting
    parts.push(`Your usual greeting, as an example: "${speakerLine(text, card.name)}"`)
  }

  const examples: string[] = []
  let chars = 0
  for (const example of card.messageExample ?? []) {
    const text = example.map(line => speakerLine(line.trim(), card.name)).filter(Boolean).join('\n')
    if (!text || chars + text.length > CARD_VOICE_LIMITS.maxExampleChars)
      break
    examples.push(text)
    chars += text.length
  }
  if (examples.length)
    parts.push(`Examples of how you talk. They show your voice and manner, and they are not real history:\n${examples.join('\n\n')}`)

  return parts.join('\n\n')
}
