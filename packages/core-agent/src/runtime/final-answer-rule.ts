/**
 * The last rule of each chat system prompt: the reply is one final answer.
 *
 * Some models have two kinds of reply messages: a commentary message for progress, and the final answer.
 * A live check on 2026-11-15 saw gpt-6-luna write its spoken line as a commentary message. It then added stray words,
 * or wrote the line again as the final answer.
 *
 * With this rule, and without the word "commentary" in the notice, 58 of 60 replies ended right after the line.
 * Before, 2 of 20 did. The rule works only in the system prompt. In the user message, 7 of 20 replies ended well.
 */
export const FINAL_ANSWER_RULE = 'Write your whole reply once, as your final answer. Do not send a commentary message, a preamble, or a progress update before it.'
