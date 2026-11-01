import type { InitiativeMode, InitiativeTrigger } from './initiative'
import type { Intention } from './intentions'
import type { SpeechType } from './speech-types'
import type { TopicSeed, TopicThread } from './topics'

import { dayPartOf } from './initiative'
import { TOPIC_LIMITS } from './topics'

/** The count of recent lines in the notice. The model reads them to avoid the same opening and structure. */
export const INITIATIVE_RECENT_LINE_COUNT = 3

/** Each recent line is cut to this length, so the situation block stays near its budget of about 300 tokens. */
const RECENT_LINE_MAX_LENGTH = 120

const MINUTE_MS = 60_000

/** What the situation block of one autonomous turn says. The host fills it from the decision and the conversation. */
export interface InitiativeNoticeContext {
  readonly mode: InitiativeMode
  readonly trigger: InitiativeTrigger
  /** The hint of the decision. Undefined in the hintless share of turns. */
  readonly speechType?: SpeechType
  /** Epoch milliseconds of the turn. */
  readonly now: number
  /** Minutes since local midnight, 0 to 1439. */
  readonly localMinutes: number
  /** Epoch milliseconds of the last owner message in this conversation. */
  readonly lastOwnerAt?: number
  /** Epoch milliseconds of the last line of the character in this conversation. */
  readonly lastSpokeAt?: number
  /** The last lines that the character started on its own, oldest first. Only the last few count. */
  readonly recentLines: readonly string[]
  /** The open intentions of the character, oldest first. */
  readonly intentions?: readonly Intention[]
  /** How long the owner was away, for a welcome back. */
  readonly awayMs?: number
  /** The thread that the last autonomous lines follow. */
  readonly thread?: TopicThread
  /** Epoch milliseconds when small talk ends, while the owner asked for small talk. */
  readonly smallTalkEndsAt?: number
  /** Topics that the character can take up. The host draws them with `pickTopicSeeds`. */
  readonly seeds?: readonly TopicSeed[]
}

const TRIGGER_REASONS: Record<InitiativeTrigger, string> = {
  'event': 'something happened',
  'boredom': 'it has been quiet for a while',
  'intention': 'you wanted to do something later',
  'greeting': 'the owner just opened the app. Greet the owner in a way that fits the time of day and how long ago you last talked',
  'welcome-back': 'the owner just came back to the computer after time away. Welcome the owner back in a few words',
}

const SPEECH_TYPE_HINTS: Record<SpeechType, string> = {
  'react': 'react to something that just happened',
  'joke': 'say something light or playful',
  'ask': 'ask the owner a question',
  'recall': 'bring up a memory or an earlier topic',
  'think-aloud': 'say a passing thought',
  'watch-quietly': 'give a very short remark, or stay quiet',
}

/**
 * Builds the situation block of one autonomous turn. It is the text of a transient notice.
 *
 * The block has a fixed shape and a size limit: the reason, the time of day, the time since the last messages, a light
 * hint, the current topic and a few topic ideas, and the last lines of the character. The hint and the ideas are
 * optional, so the model can ignore them. The model ends its line with a topic label, so code can follow topics.
 *
 * @example
 * initiativeNoticeText({ mode: 'idle', trigger: 'boredom', speechType: 'ask', now, localMinutes: 1200, recentLines: [] })
 * // => 'Autonomous turn: nobody asked you to speak. ...'
 */
export function initiativeNoticeText(context: InitiativeNoticeContext): string {
  const lines = [
    'Autonomous turn: nobody asked you to speak. You can start talking on your own, or stay quiet.',
    `- Why now: ${TRIGGER_REASONS[context.trigger]}.`,
    `- Time of day: ${dayPartOf(context.localMinutes)}.`,
    `- Since the owner's last message: ${durationSince(context.lastOwnerAt, context.now)}.`,
    `- Since your last line: ${durationSince(context.lastSpokeAt, context.now)}.`,
  ]
  if (context.awayMs !== undefined)
    lines.push(`- The owner was away for: ${durationSince(context.now - context.awayMs, context.now)}.`)
  if (context.mode === 'commentary')
    lines.push('- Mode: commentary. Keep it to one short sentence.')
  if (context.smallTalkEndsAt !== undefined)
    lines.push(`- Mode: small talk. The owner asked you to keep them company for ${durationSince(context.now, context.smallTalkEndsAt)} more. Talk freely, and keep the talk going.`)
  if (context.speechType)
    lines.push(`- Idea, only if it fits: ${SPEECH_TYPE_HINTS[context.speechType]}.`)

  if (context.intentions?.length) {
    lines.push('- What you wanted to do later. Use one only if it fits now. After you do it, finish it with its id:')
    lines.push(...context.intentions.map(intention => `  - ${intention.id}: "${truncate(intention.text, RECENT_LINE_MAX_LENGTH)}" (noted ${durationSince(intention.createdAt, context.now)} ago)`))
  }

  if (context.thread) {
    const topic = truncate(context.thread.topic, TOPIC_LIMITS.maxLabelLength)
    lines.push(context.thread.cold
      ? `- Your current topic "${topic}" is cold. Move to a new topic.`
      : `- Your current topic: "${topic}". You can continue it or move to a related topic.`)
  }
  if (context.seeds?.length) {
    lines.push('- Topic ideas, only if one fits:')
    lines.push(...context.seeds.map(seed => `  - ${truncate(seed.text, TOPIC_LIMITS.maxSeedLength)}`))
  }

  const recent = context.recentLines.slice(-INITIATIVE_RECENT_LINE_COUNT).map(line => line.trim()).filter(Boolean)
  if (recent.length) {
    lines.push('- Your last lines that you started. Do not repeat their opening or structure:')
    lines.push(...recent.map(line => `  - "${truncate(line, RECENT_LINE_MAX_LENGTH)}"`))
  }
  lines.push('Keep it short and natural, one or two sentences.')
  lines.push('If you speak, end with <|TOPIC a few words|> that name your topic, in the language of your line. Nobody sees or hears it.')
  return lines.join('\n')
}

function durationSince(at: number | undefined, now: number) {
  if (at === undefined)
    return 'none in this conversation'
  const minutes = Math.max(0, Math.round((now - at) / MINUTE_MS))
  if (minutes < 1)
    return 'less than a minute'
  if (minutes < 60)
    return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  if (hours < 48)
    return `about ${hours} hour${hours === 1 ? '' : 's'}`
  return `about ${Math.floor(hours / 24)} days`
}

function truncate(text: string, maxLength: number) {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat
}
