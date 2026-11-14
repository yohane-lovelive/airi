import type { Tool } from '@xsai/shared-chat'

import type { OwnerMotionRequestResult } from '../stores/motion-generation'

import { rawTool } from '@xsai/tool'
import { description, maxLength, minLength, pipe, safeParse, strictObject, string, summarize } from 'valibot'
import { toJsonSchema } from 'xsschema'

export const PERFORM_MOTION_TOOL_NAME = 'builtIn_performMotion'

/** The longest motion text. A marker motion is a short phrase. */
const MAX_MOTION_LENGTH = 120

const performParameters = strictObject({
  // The generator reads English. Its own translation lost meaning, for example "振り下ろす" became "wield", so the chat
  // model writes the English.
  motion: pipe(string(), minLength(1), maxLength(MAX_MOTION_LENGTH), description(`The movement in one short English sentence of what the body does: which arm or hand, and which direction. Translate the owner's words when they are not English. For example "raise a sword overhead with both hands and swing it down" for "剣を振り下ろして".`)),
})

/** What the motion tool reads and starts. */
interface CreatePerformMotionToolOptions {
  /** The name of the enabled clip of the library that fits the motion, or undefined. */
  match: (motion: string) => string | undefined
  /** Asks the generator for a clip that plays when it is ready. */
  generate: (motion: string) => Promise<OwnerMotionRequestResult>
}

/**
 * Creates the tool that performs a movement that the owner asks for.
 *
 * - A clip of the library that fits plays through an `ACT` marker of the reply, so it starts with the speech and the
 *   expression.
 * - Without a clip, the generator makes one after the reply, and the stage plays it when it is ready.
 *
 * Use when:
 * - The model is VRM or MMD in the owner's own conversation.
 *
 * Returns:
 * - One tool. Its result tells the model what to write.
 */
export async function createPerformMotionTool(options: CreatePerformMotionToolOptions): Promise<Tool[]> {
  return [rawTool({
    name: PERFORM_MOTION_TOOL_NAME,
    description: 'Call this first when the owner asks you to do or show a movement, for example "swing a sword", "剣を振るところを見せて", or "踊って". It tells you how to do it. For small gestures of your own while you talk, write ACT markers instead.',
    parameters: await toJsonSchema(performParameters),
    execute: async (input) => {
      const parsed = safeParse(performParameters, input)
      if (!parsed.success)
        return `The motion is not valid: ${summarize(parsed.issues)}`
      const motion = parsed.output.motion.trim()

      const name = options.match(motion)
      if (name)
        return `A gesture fits: "${name}". Write <|ACT ${JSON.stringify({ motion: name })}|> in your reply where you do it.`

      const result = await options.generate(motion)
      if (result.ok)
        return 'No gesture fits, so the motion is being made now. It plays when it is ready, after your reply. Say a short line that you will do it, and write no ACT motion for it.'
      return `No gesture fits, and no motion can be made: ${result.reason} Tell the owner briefly. You can use a near gesture from the list, or none.`
    },
  })]
}
