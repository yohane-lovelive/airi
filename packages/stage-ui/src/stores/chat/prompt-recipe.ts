import type { Recipe } from '@proj-airi/core-agent'

import type { ReplyLength } from '../modules/consciousness-settings'

/** Format rules that the chat renderer needs from every reply. */
export const CHAT_FORMAT_RULES = `${[
  // Only listed languages load in the renderer, so every code block names its language.
  '- For any programming code block, always specify the programming language that supported on @shikijs/rehype on the rendered markdown, eg. ```python ... ```',
  '- Use $$...$$ for inline math.',
  '- Use a separate multiline $$ block for each display equation.',
  '- Use a latex fence for a list of independent one-line equations.',
  '- Use a math fence for one multiline equation or LaTeX environment.',
  '- Do not use single dollar signs as math delimiters.',
].join('\n')}\n`

/**
 * Builds the system prompt of one run: format rules, then the identity of the run's persona.
 *
 * Use when:
 * - A chat run starts. Identity is read for its persona then, so history never stores it.
 */
export function composeSystemPrompt(identity: string) {
  return CHAT_FORMAT_RULES + identity
}

const REPLY_LENGTH_TEXT: Record<Exclude<ReplyLength, 'free'>, string> = {
  auto: 'When you answer the owner, match the length of your reply to the owner\'s message. A greeting, thanks, or a short remark gets one or two sentences. A question or a story gets a few sentences. Write more only when the owner asks you to explain or to tell more.',
  short: 'When you answer the owner, use one or two sentences, unless the owner asks for more.',
  normal: 'When you answer the owner, use two to four sentences, unless the owner asks for more.',
  long: 'When you answer the owner, take the room that the topic needs.',
}

/**
 * The length instruction of replies to the owner. It changes only when the owner changes the setting, so the cached
 * prefix stays. Autonomous lines get their own length in their notice.
 */
export function composeReplyLengthPrompt(length: ReplyLength) {
  return length === 'free' ? '' : `\n\n${REPLY_LENGTH_TEXT[length]}`
}

/**
 * Prompt part of a session that is a recipe's own space. It follows the identity and stays the same for every run there, so the prefix stays cacheable.
 * The recipe reports a result to the conversation.
 */
export function composeRecipeSpacePrompt(recipe: Recipe) {
  const purpose = recipe.description.trim() ? `Purpose: ${recipe.description.trim()}\n` : ''
  const steps = `${purpose}Recipe steps:\n${recipe.instructions.trim()}`
  return `\n\nYou run the recipe "${recipe.name}" in its own space for your conversation with the owner. Each message here is a task from that conversation. Your reply is the recipe's result: the conversation receives it and decides what to tell the owner, so report what you found or did, briefly.\n\n${steps}`
}
