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
  /**
   * Who is who in the current scene: the character of the owner, its allies, and its opponents. A line can name them.
   * A new cast takes the place of the old one.
   */
  readonly cast?: { readonly text: string, readonly at: number }
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
  maxCastLength: 400,
  /** The situation block leaves out a cast older than this. A match of a game ends sooner, and its cast with it. */
  maxCastAgeMs: 90 * 60_000,
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

const MARKER = /^<\|(NOTE|SCENE|CAST)\s([\s\S]*)\|>$/

/** What a timeline marker of the character writes: a note, the current scene, or the cast of the scene. */
export type TimelineMarkerKind = 'note' | 'scene' | 'cast'

const MARKER_KINDS: Record<string, { kind: TimelineMarkerKind, maxLength: number }> = {
  NOTE: { kind: 'note', maxLength: TIMELINE_LIMITS.maxNoteLength },
  SCENE: { kind: 'scene', maxLength: TIMELINE_LIMITS.maxSceneLength },
  CAST: { kind: 'cast', maxLength: TIMELINE_LIMITS.maxCastLength },
}

/**
 * Reads a `<|NOTE ...|>`, `<|SCENE ...|>`, or `<|CAST ...|>` marker. Returns `undefined` for another marker or an
 * empty text.
 *
 * @example
 * timelineMarkerFrom('<|NOTE the boss fight started|>')
 * // => { kind: 'note', text: 'the boss fight started' }
 */
export function timelineMarkerFrom(special: string): { kind: TimelineMarkerKind, text: string } | undefined {
  const match = MARKER.exec(special.trim())
  const marker = match ? MARKER_KINDS[match[1]] : undefined
  if (!match || !marker)
    return undefined
  const text = clean(match[2] ?? '', marker.maxLength)
  return text ? { kind: marker.kind, text } : undefined
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

/** Replaces the cast of the current scene. */
export function setTimelineCast(timeline: Timeline, text: string, at: number): Timeline {
  const cast = clean(text, TIMELINE_LIMITS.maxCastLength)
  return cast ? { ...timeline, cast: { text: cast, at } } : timeline
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
