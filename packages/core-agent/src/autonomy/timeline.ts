import type { Conversation } from '../messages/types'

/**
 * One short note of what happened on the owner's screen.
 *
 * - `code`: code wrote it, for example an app switch or a mission start.
 * - `model`: the character wrote it with a `<|NOTE ...|>` marker, for example "the boss fight started".
 */
export interface TimelineNote {
  readonly at: number
  readonly text: string
  readonly source: 'code' | 'model'
}

/**
 * The screen history of one conversation: the recent notes, a summary of older notes, and the current scene.
 * It is the only history of the screen, because frames never stay.
 */
export interface Timeline {
  /** Oldest first. */
  readonly notes: readonly TimelineNote[]
  /** What the current scene is, for example the game, the place, the goal, and the state of the player. */
  readonly scene?: { readonly text: string, readonly at: number }
  /** A summary of the notes up to `until`. */
  readonly summary?: { readonly text: string, readonly until: number }
}

/** Limits of the timeline. The notice and the summary request read them. */
export const TIMELINE_LIMITS = {
  /** Past this count, the oldest notes go into the summary. */
  maxNotes: 30,
  /** One summary takes this many of the oldest notes. */
  summarizeCount: 15,
  /** A note older than this goes into the summary, also below the count. */
  maxAgeMs: 12 * 60 * 60_000,
  maxNoteLength: 120,
  maxSceneLength: 300,
  maxSummaryLength: 600,
  /** The character writes at most this many notes in one turn. */
  maxModelNotesPerTurn: 2,
  /** The situation block lists this many of the newest notes. */
  promptNotes: 12,
} as const

/** An empty timeline. */
export const EMPTY_TIMELINE: Timeline = { notes: [] }

function clean(text: string, maxLength: number) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat
}

const MARKER = /^<\|(NOTE|SCENE)\s([\s\S]*)\|>$/

/**
 * Reads a `<|NOTE ...|>` or `<|SCENE ...|>` marker. Returns `undefined` for another marker or an empty text.
 *
 * @example
 * timelineMarkerFrom('<|NOTE the boss fight started|>')
 * // => { kind: 'note', text: 'the boss fight started' }
 */
export function timelineMarkerFrom(special: string): { kind: 'note' | 'scene', text: string } | undefined {
  const match = MARKER.exec(special.trim())
  if (!match)
    return undefined
  const kind = match[1] === 'NOTE' ? 'note' : 'scene'
  const text = clean(match[2] ?? '', kind === 'note' ? TIMELINE_LIMITS.maxNoteLength : TIMELINE_LIMITS.maxSceneLength)
  return text ? { kind, text } : undefined
}

/** Adds notes in time order. Each text is cleaned and cut to its limit, and an empty text is dropped. */
export function addTimelineNotes(timeline: Timeline, notes: readonly TimelineNote[]): Timeline {
  const added = notes
    .map(note => ({ ...note, text: clean(note.text, TIMELINE_LIMITS.maxNoteLength) }))
    .filter(note => note.text)
  if (!added.length)
    return timeline
  return { ...timeline, notes: [...timeline.notes, ...added].sort((left, right) => left.at - right.at) }
}

/** Replaces the current scene. */
export function setTimelineScene(timeline: Timeline, text: string, at: number): Timeline {
  const scene = clean(text, TIMELINE_LIMITS.maxSceneLength)
  return scene ? { ...timeline, scene: { text: scene, at } } : timeline
}

/**
 * The notes that the next summary takes: the oldest notes past the count limit, and every note past the age limit.
 * Returns `undefined` when no note needs a summary.
 */
export function timelineNotesToSummarize(timeline: Timeline, now: number): readonly TimelineNote[] | undefined {
  const overCount = timeline.notes.length > TIMELINE_LIMITS.maxNotes ? TIMELINE_LIMITS.summarizeCount : 0
  const old = timeline.notes.filter(note => now - note.at > TIMELINE_LIMITS.maxAgeMs).length
  const count = Math.max(overCount, old)
  return count ? timeline.notes.slice(0, count) : undefined
}

/** Puts a summary in place of the notes up to `until`. Notes that came later stay. */
export function applyTimelineSummary(timeline: Timeline, text: string, until: number): Timeline {
  const summary = clean(text, TIMELINE_LIMITS.maxSummaryLength)
  if (!summary)
    return timeline
  return { ...timeline, notes: timeline.notes.filter(note => note.at > until), summary: { text: summary, until } }
}

/** The request that summarizes old notes together with the earlier summary. */
export function timelineSummaryRequest(timeline: Timeline, notes: readonly TimelineNote[]): Conversation {
  const instruction = [
    'You keep the history of what happened on the owner\'s screen, as short notes with times.',
    `Write one summary of the earlier summary and the notes, in at most ${TIMELINE_LIMITS.maxSummaryLength} characters.`,
    'Keep what matters later: the apps, the games and their progress, goals, wins and losses. Leave out small repeats.',
    'Write in the language of the notes. Write the summary only, without a heading.',
  ].join('\n')
  const lines = notes.map(note => `- ${new Date(note.at).toISOString()}: ${note.text}`).join('\n')
  return {
    turns: [
      { type: 'system', id: 'timeline-summary-instruction', authority: 'system', content: [{ type: 'text', text: instruction }] },
      {
        type: 'user',
        id: 'timeline-summary-input',
        content: [{ type: 'text', text: `${timeline.summary ? `Earlier summary:\n${timeline.summary.text}\n\n` : ''}Notes:\n${lines}` }],
      },
    ],
  }
}
