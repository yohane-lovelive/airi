/**
 * The kinds of text that the embedder takes. Each kind gets the prefix that EmbeddingGemma 2 was trained with.
 *
 * - `query`: a search query, for example the newest owner message.
 * - `document`: a memory entry that a query searches.
 * - `similarity`: a text that is compared with texts of the same kind, for example a topic label.
 */
export const EMBEDDING_TASKS = ['query', 'document', 'similarity'] as const
export type EmbeddingTask = typeof EMBEDDING_TASKS[number]

/**
 * The model makes 768 dimensions and supports Matryoshka truncation. At 256 the multilingual MTEB score falls from
 * 61.36 to 60.41, and the storage is a third.
 */
export const EMBEDDING_DIMENSIONS = 256

const PREFIXES: Record<EmbeddingTask, string> = {
  query: 'task: search result | query: ',
  document: 'title: none | text: ',
  similarity: 'task: sentence similarity | query: ',
}

/** Puts the prefix of the task before the text. */
export function withPrefix(text: string, task: EmbeddingTask) {
  return `${PREFIXES[task]}${text}`
}

/**
 * Cuts a vector to its first `dimensions` values and scales it to length 1. A cut vector is no longer normalized,
 * so a dot product of two cut vectors is a cosine only after this step.
 */
export function truncateAndNormalize(vector: ArrayLike<number>, dimensions = EMBEDDING_DIMENSIONS): number[] {
  const cut = Array.from({ length: Math.min(dimensions, vector.length) }, (_, index) => vector[index])
  const length = Math.hypot(...cut)
  return length > 0 ? cut.map(value => value / length) : cut
}
