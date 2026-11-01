import type { Conversation } from '@proj-airi/core-agent'

import { formatLocalDateTime } from '@proj-airi/core-agent'

/**
 * Why a model call ran.
 *
 * - `owner-reply`: a reply to an owner message.
 * - `initiative`: autonomous speech without an owner message.
 * - `mission`: a mission notice, for example a reminder.
 * - `task`: a background task, and the notice of its result.
 * - `scene`: a reply in a session that answers other people.
 * - `vision`: a description of an image for a model without image input.
 * - `voice-assist`: the voice end judgement and the transcript rewrite.
 * - `tool-card`: a card program for a tool result.
 * - `artistry`: the image prompt of the artistry module.
 * - `history-summary`: the summary of the older messages of a conversation.
 * - `other`: a call that names no purpose.
 */
export const USAGE_PURPOSES = ['owner-reply', 'initiative', 'mission', 'task', 'scene', 'vision', 'voice-assist', 'tool-card', 'artistry', 'history-summary', 'timeline', 'other'] as const

export type UsagePurpose = typeof USAGE_PURPOSES[number]

/** The device keeps the usage of this many days, today included. */
export const USAGE_RETENTION_DAYS = 30

/** One finished stream. A stream with tool rounds holds one model call for each round. */
export interface UsageCall {
  purpose: UsagePurpose
  model: string
  at: number
  calls: number
  /** The token counts. Undefined when the provider reported none, for example after a cancel or a failure. */
  tokens?: { input: number, output: number, total: number }
  images: number
}

/** The usage of one day, purpose, and model. */
export interface UsageRecord {
  day: string
  purpose: UsagePurpose
  model: string
  calls: number
  /** Calls whose stream reported no tokens. Their tokens are not in the sums. */
  unreportedCalls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  images: number
}

/** The sums of one purpose. */
export type UsageTotals = Omit<UsageRecord, 'day' | 'purpose' | 'model'>

/**
 * The local day of a time.
 *
 * @example
 * usageDayOf(new Date(2026, 10, 1, 9, 30).getTime())
 * // => '2026-11-01'
 */
export function usageDayOf(time: number) {
  return formatLocalDateTime(time).slice(0, 10)
}

/** The first day that the device keeps at `now`. Older records are removed. */
export function firstKeptUsageDay(now: number) {
  const date = new Date(now)
  date.setDate(date.getDate() - (USAGE_RETENTION_DAYS - 1))
  return usageDayOf(date.getTime())
}

export function usageKeyOf(record: Pick<UsageRecord, 'day' | 'purpose' | 'model'>) {
  return `${record.day}|${record.purpose}|${record.model}`
}

/** Adds one call to the record of its day, purpose, and model. */
export function addUsageCall(record: UsageRecord | undefined, call: UsageCall): UsageRecord {
  const base = record ?? { day: usageDayOf(call.at), purpose: call.purpose, model: call.model, calls: 0, unreportedCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, images: 0 }
  return {
    ...base,
    calls: base.calls + call.calls,
    unreportedCalls: base.unreportedCalls + (call.tokens ? 0 : call.calls),
    inputTokens: base.inputTokens + (call.tokens?.input ?? 0),
    outputTokens: base.outputTokens + (call.tokens?.output ?? 0),
    totalTokens: base.totalTokens + (call.tokens?.total ?? 0),
    images: base.images + call.images,
  }
}

function emptyTotals(): UsageTotals {
  return { calls: 0, unreportedCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, images: 0 }
}

/**
 * Sums the records from `fromDay` on, for each purpose. Purposes without a call are left out.
 * The purposes follow {@link USAGE_PURPOSES}.
 */
export function usageByPurpose(records: readonly UsageRecord[], fromDay: string) {
  const totals = new Map<UsagePurpose, UsageTotals>()
  for (const record of records) {
    if (record.day < fromDay)
      continue
    const sum = totals.get(record.purpose) ?? emptyTotals()
    for (const key of Object.keys(sum) as (keyof UsageTotals)[])
      sum[key] += record[key]
    totals.set(record.purpose, sum)
  }
  return USAGE_PURPOSES.flatMap((purpose) => {
    const sum = totals.get(purpose)
    return sum ? [{ purpose, ...sum }] : []
  })
}

/** The images in a request: the images of the owner turns and of the tool results. */
export function countRequestImages(conversation: Conversation) {
  let images = 0
  for (const turn of conversation.turns) {
    if (turn.type === 'user') {
      images += turn.content.filter(part => part.type === 'image').length
      continue
    }
    if (turn.type !== 'assistant')
      continue
    for (const round of turn.rounds) {
      for (const invocation of round.toolInvocations) {
        if ('output' in invocation.execution)
          images += invocation.execution.output.filter(segment => segment.type === 'image').length
      }
    }
  }
  return images
}
