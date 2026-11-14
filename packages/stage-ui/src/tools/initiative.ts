import type { Intention, IntentionRequest, TalkControl, TalkLevelRequest } from '@proj-airi/core-agent'
import type { Tool } from '@xsai/shared-chat'

import { formatLocalDateTime, INTENTION_LIMITS, TALK_CONTROL_LIMITS } from '@proj-airi/core-agent'
import { rawTool } from '@xsai/tool'
import { description, integer, maxLength, maxValue, minLength, minValue, number, picklist, pipe, safeParse, strictObject, string, summarize } from 'valibot'
import { toJsonSchema } from 'xsschema'

export const ADD_INTENTION_TOOL_NAME = 'builtIn_addIntention'
export const LIST_INTENTIONS_TOOL_NAME = 'builtIn_listIntentions'
export const FINISH_INTENTION_TOOL_NAME = 'builtIn_finishIntention'
export const SET_TALK_LEVEL_TOOL_NAME = 'builtIn_setTalkLevel'

const addParameters = strictObject({
  text: pipe(string(), minLength(1), maxLength(INTENTION_LIMITS.maxTextLength), description('What you want to do later, in your own words, for example "ask about the trip".')),
  hours: pipe(number(), integer(), minValue(INTENTION_LIMITS.minHours), maxValue(INTENTION_LIMITS.maxHours), description(`How long the intention stays, ${INTENTION_LIMITS.minHours} to ${INTENTION_LIMITS.maxHours} hours. Usually ${INTENTION_LIMITS.defaultHours}.`)),
})
const listParameters = strictObject({})
const finishParameters = strictObject({ id: pipe(string(), minLength(1), description('The intention id, as the list shows it.')) })
// Strict function calling needs every property in `required`, so `minutes` is always present, and the kind tells whether
// it counts.
const talkLevelParameters = strictObject({
  kind: pipe(picklist(['quiet', 'less', 'more', 'normal']), description('"quiet": no talk on your own for a time. "less" or "more": talk on your own less or more often. "normal": end every change for a time.')),
  minutes: pipe(number(), integer(), minValue(0), maxValue(TALK_CONTROL_LIMITS.maxMinutes), description(`For "quiet": 1 to ${TALK_CONTROL_LIMITS.maxMinutes}. For "less" or "more": the minutes of the change, or 0 when the owner wants it to stay. For "normal": 0.`)),
})

/** What the intention tools change. */
interface CreateIntentionToolsOptions {
  /** The open intentions now. */
  open: () => readonly Intention[]
  add: (request: IntentionRequest) => Promise<{ ok: true, intention: Intention } | { ok: false, reason: string }>
  finish: (id: string) => Promise<boolean>
}

function describeIntention(intention: Intention) {
  return `- ${intention.id}: "${intention.text}", until ${formatLocalDateTime(intention.expiresAt).replace('T', ' ')}`
}

/**
 * Creates the intention tools: notes of what the character wants to do later.
 * Autonomous turns show the open intentions, and finish one after it is done.
 */
export async function createIntentionTools(options: CreateIntentionToolsOptions): Promise<Tool[]> {
  return [
    rawTool({
      name: ADD_INTENTION_TOOL_NAME,
      description: `Note something that you want to do later on your own, for example ask the owner how the trip went. You see it again when you talk on your own. At most ${INTENTION_LIMITS.maxOpen} open intentions. For a reminder that the owner asks for, use a mission instead.`,
      parameters: await toJsonSchema(addParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(addParameters, rawInput)
        if (!parsed.success)
          return `Intention not added: ${summarize(parsed.issues)}`
        const result = await options.add(parsed.output)
        if (!result.ok)
          return `Intention not added: ${result.reason}`
        return `Added intention:\n${describeIntention(result.intention)}`
      },
    }),
    rawTool({
      name: LIST_INTENTIONS_TOOL_NAME,
      description: 'List your open intentions with their ids.',
      parameters: await toJsonSchema(listParameters),
      execute: async () => {
        const open = options.open()
        return open.length ? open.map(describeIntention).join('\n') : 'No open intentions.'
      },
    }),
    rawTool({
      name: FINISH_INTENTION_TOOL_NAME,
      description: 'Finish an open intention after you did it, or when it no longer fits.',
      parameters: await toJsonSchema(finishParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(finishParameters, rawInput)
        if (!parsed.success)
          return 'Give the id of an open intention.'
        return await options.finish(parsed.output.id) ? `Finished intention "${parsed.output.id}".` : 'No open intention with that id.'
      },
    }),
  ]
}

/** The talk level after a request: the temporary changes, and the idle interval of Settings. */
export type TalkLevelApplyResult
  = | { ok: true, control: TalkControl, idleIntervalMinutes: number }
    | { ok: false, reason: string }

/** What the talk level tool reads and changes. */
interface CreateTalkLevelToolOptions {
  /** Whether the current turn answers an owner message. Only the owner changes the talk level. */
  answersOwner: () => boolean
  apply: (request: TalkLevelRequest) => Promise<TalkLevelApplyResult>
}

function timeOf(epochMs: number) {
  return formatLocalDateTime(epochMs).slice(11)
}

function describeTalkLevel(result: Extract<TalkLevelApplyResult, { ok: true }>) {
  const parts = [`Your own talk comes about every ${result.idleIntervalMinutes} minutes.`]
  if (result.control.quietUntil !== undefined)
    parts.push(`Quiet until ${timeOf(result.control.quietUntil)}.`)
  if (result.control.interval)
    parts.push(`Until ${timeOf(result.control.interval.until)}, the time between your lines is ${Math.round(result.control.interval.factor * 100)}% of that.`)
  return parts.join(' ')
}

/**
 * Creates the talk level tool. The owner changes how often the character talks on its own, with words in chat.
 * Code checks each value. The tool refuses in a turn that does not answer the owner, for example an autonomous turn.
 */
export async function createTalkLevelTool(options: CreateTalkLevelToolOptions): Promise<Tool[]> {
  return [
    rawTool({
      name: SET_TALK_LEVEL_TOOL_NAME,
      description: 'Change how often you talk on your own, only when the owner asks, for example "be quiet for 30 minutes" or "you can talk more".',
      parameters: await toJsonSchema(talkLevelParameters),
      execute: async (rawInput) => {
        if (!options.answersOwner())
          return 'Talk level not changed: only the owner can change it, in a reply to the owner\'s message.'
        const parsed = safeParse(talkLevelParameters, rawInput)
        if (!parsed.success)
          return `Talk level not changed: ${summarize(parsed.issues)}`
        const { kind, minutes } = parsed.output
        const result = await options.apply(kind === 'normal' ? { kind } : { kind, minutes })
        if (!result.ok)
          return `Talk level not changed: ${result.reason}`
        return `Talk level changed. ${describeTalkLevel(result)}`
      },
    }),
  ]
}
