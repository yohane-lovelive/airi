import type { TopicSimilarity } from '@proj-airi/core-agent'

import { bigramSimilarity, scaledCosine } from '@proj-airi/core-agent'

/** How the last comparison of topics worked: by label vectors from the server, or by shared character pairs. */
export type TopicSimilarityMode = 'vectors' | 'characters'

export interface TopicVectorsOptions {
  /** Embeds short texts in order. It throws when the server cannot answer. */
  embed: (texts: string[], signal: AbortSignal) => Promise<number[][]>
  /** @default 500 */
  capacity?: number
  /** @default 1_500 */
  timeoutMs?: number
}

/** The embed route takes 32 texts of 200 characters at most in one request. */
const BATCH_LIMIT = 32
const TEXT_LIMIT = 200

function keyOf(text: string) {
  return text.replace(/\s+/g, ' ').trim().slice(0, TEXT_LIMIT)
}

/**
 * Keeps the vectors of recent topic labels and seeds, so the policy can compare topics by meaning.
 *
 * The policy compares topics with a synchronous function. So a turn first calls {@link prepare} with the texts that it
 * compares, and then passes {@link similarity}. A pair without both vectors falls back to character pairs, on the same
 * scale.
 *
 * Use when:
 * - The initiative runner finds the current thread, draws seeds, and measures variety.
 */
export class TopicVectors {
  private readonly vectors = new Map<string, number[]>()
  private readonly capacity: number
  private readonly timeoutMs: number
  private mode: TopicSimilarityMode = 'characters'

  constructor(private readonly options: TopicVectorsOptions) {
    this.capacity = options.capacity ?? 500
    this.timeoutMs = options.timeoutMs ?? 1_500
  }

  /** How the last turn compared topics. */
  get lastMode() {
    return this.mode
  }

  /**
   * Embeds the texts that have no vector yet, in one request. A failure or a timeout leaves them without a vector, so
   * their pairs compare by character pairs.
   */
  async prepare(texts: readonly string[]) {
    const keys = [...new Set(texts.map(keyOf).filter(Boolean))]
    const missing = keys.filter(key => !this.vectors.has(key)).slice(0, BATCH_LIMIT)
    if (missing.length) {
      try {
        const embedded = await this.options.embed(missing, AbortSignal.timeout(this.timeoutMs))
        for (const [index, key] of missing.entries())
          this.vectors.set(key, embedded[index])
      }
      catch {
        // The pairs of these texts compare by character pairs this turn. A later turn asks again.
      }
    }
    // Recently used texts move to the end, so the oldest ones leave first.
    for (const key of keys) {
      const vector = this.vectors.get(key)
      if (vector) {
        this.vectors.delete(key)
        this.vectors.set(key, vector)
      }
    }
    for (const key of this.vectors.keys()) {
      if (this.vectors.size <= this.capacity)
        break
      this.vectors.delete(key)
    }
    this.mode = keys.length > 0 && keys.every(key => this.vectors.has(key)) ? 'vectors' : 'characters'
  }

  /** The similarity of two topics on the scale of character pairs. */
  readonly similarity: TopicSimilarity = (left, right) => {
    const leftVector = this.vectors.get(keyOf(left))
    const rightVector = this.vectors.get(keyOf(right))
    return leftVector && rightVector ? scaledCosine(leftVector, rightVector) : bigramSimilarity(left, right)
  }
}
