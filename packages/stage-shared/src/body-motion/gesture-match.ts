/** A gesture that a marker can choose: its id, tags, and description. */
export interface GestureCandidate {
  id: string
  /** The name that the prompt lists, for example `tilt-head`. It counts as one more tag. */
  name?: string
  tags: readonly string[]
  description: string
}

/** A tag hit counts 2, and a description word counts 1. A gesture needs this score, so one tag or two words. */
const MIN_SCORE = 2
/** Shorter English tags must match a whole word, so `hi` does not match `his`. */
const MIN_PREFIX_LENGTH = 3
const MIN_DESCRIPTION_WORD = 4

function englishWords(text: string) {
  return text.toLowerCase().match(/[a-z]+/g) ?? []
}

/** `wave` matches `waves` and `waving`, and `nod` matches `nodding`. */
function stemOf(word: string) {
  return word.length > MIN_PREFIX_LENGTH && word.endsWith('e') ? word.slice(0, -1) : word
}

function matchesWord(words: readonly string[], tag: string) {
  const stem = stemOf(tag)
  return words.some(word => tag.length < MIN_PREFIX_LENGTH ? word === tag : word.startsWith(stem))
}

function scoreOf(candidate: GestureCandidate, text: string, words: readonly string[]) {
  let score = 0
  for (const tag of candidate.name ? [candidate.name, ...candidate.tags] : candidate.tags) {
    const lower = tag.toLowerCase()
    // An English tag matches words. A Japanese tag is a stem, so it matches as a part of the text.
    const hit = /^[a-z]+$/.test(lower) ? matchesWord(words, lower) : text.includes(lower)
    if (hit)
      score += 2
  }
  for (const word of new Set(englishWords(candidate.description))) {
    if (word.length >= MIN_DESCRIPTION_WORD && matchesWord(words, word))
      score += 1
  }
  return score
}

/**
 * Chooses the gesture that fits the free-text `motion` of an `ACT` marker, for example `scratch head shyly` or
 * `小さく手を振る`.
 *
 * Use when:
 * - A renderer plays a gesture of the library for a marker. Embeddings can replace this match when the library grows,
 *   and the marker stays the same.
 *
 * Returns:
 * - The id of the best gesture, or undefined when none scores enough.
 */
export function matchGesture(motion: string, candidates: readonly GestureCandidate[]): string | undefined {
  const text = motion.toLowerCase()
  const words = englishWords(text)
  let best: { id: string, score: number } | undefined
  for (const candidate of candidates) {
    const score = scoreOf(candidate, text, words)
    if (score >= MIN_SCORE && (!best || score > best.score))
      best = { id: candidate.id, score }
  }
  return best?.id
}
