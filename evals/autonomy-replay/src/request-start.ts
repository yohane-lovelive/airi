import type { Recording } from './recording'

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { array, boolean, literal, object, optional, parse, record, string, unknown } from 'valibot'

/**
 * The start of a request of the app: the system prompt of the character and the definitions of its tools. The screen
 * recorder of the desktop app writes it to `request-start.json` in a recording, at each chat request while it records.
 * With it, the replay sends a request of the size that the app sends, so the speed and the cache of a run are those
 * of the app.
 */
export interface RequestStart {
  /** The whole system prompt: the format rules, the character, the memory index, and the tool notes. */
  readonly systemPrompt: string
  /** The tools as the provider gets them. The replay answers each call with a fixed text. */
  readonly tools: readonly RequestStartTool[]
}

export interface RequestStartTool {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description?: string
    readonly parameters: Record<string, unknown>
    readonly strict?: boolean
  }
}

const requestStartSchema = object({
  systemPrompt: string(),
  tools: array(object({
    type: literal('function'),
    function: object({
      name: string(),
      description: optional(string()),
      parameters: record(string(), unknown()),
      strict: optional(boolean()),
    }),
  })),
})

/** Reads the file that the app wrote. A file of another form rejects, so a run never goes on with half of a request. */
function loadRequestStart(path: string): RequestStart {
  return parse(requestStartSchema, JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * The request start of a replay.
 *
 * - `override` is a file that the run names. It wins, so one character can replay every recording, also a video
 *   that the app did not record.
 * - Without it, the file of the recording counts: the request of the session that the app recorded.
 * - Without both, the replay has no request start and sends its short persona.
 */
export function requestStartOf(recording: Recording, override?: string): RequestStart | undefined {
  if (override)
    return loadRequestStart(override)
  const recorded = join(recording.directory, 'request-start.json')
  return existsSync(recorded) ? loadRequestStart(recorded) : undefined
}
