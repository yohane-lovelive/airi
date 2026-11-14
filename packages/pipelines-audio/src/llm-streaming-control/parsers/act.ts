import type { LlmStreamingControlParser, LlmStreamingControlTokenAct } from '../types'

const actTokenPrefix = '<|ACT '
const markerSuffix = '|>'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const CLOSER: Record<string, string> = { '{': '}', '[': ']' }

/**
 * Fixes the brackets of an object that a model closed wrongly. Text inside strings stays as it is.
 *
 * - A `}` that closes the object while more of it follows is dropped, for example `{"emotion":"curious"},"motion":"nod"}`.
 * - A closing bracket without its opener is dropped, for example the last `}` of `{"emotion":"happy"}}`.
 * - Missing closing brackets are added at the end.
 *
 * Returns:
 * - The fixed text, or undefined when a string does not end.
 */
function repairBrackets(raw: string): string | undefined {
  const text = raw.trim()
  const open: string[] = []
  let out = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      out += char
      if (escaped)
        escaped = false
      else if (char === '\\')
        escaped = true
      else if (char === '"')
        inString = false
      continue
    }
    if (char === '"') {
      inString = true
    }
    else if (char === '{' || char === '[') {
      open.push(char)
    }
    else if (char === '}' || char === ']') {
      const closesWrongly = open.length === 0 || CLOSER[open.at(-1)!] !== char
      const closesEarly = open.length === 1 && text.slice(index + 1).trim().length > 0
      if (closesWrongly || closesEarly)
        continue
      open.pop()
    }
    out += char
  }
  if (inString)
    return undefined
  return out + open.reverse().map(opener => CLOSER[opener]).join('')
}

/**
 * Reads the JSON object of an ACT token. A model sometimes closes the object wrongly. A live check on 2026-11-05 lost
 * the emotion and the gesture of such markers, so a second read fixes the brackets.
 */
function parseActPayload(raw: string): Record<string, unknown> | undefined {
  for (const candidate of [raw, repairBrackets(raw)]) {
    if (candidate === undefined)
      continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (isPlainObject(parsed))
        return parsed
    }
    catch {
      // The next candidate fixes the brackets.
    }
  }
  return undefined
}

/**
 * Creates the parser for `<|ACT {...}|>` streaming-control tokens.
 *
 * Use when:
 * - Loading the built-in performance action control
 *
 * Expects:
 * - The token body is a JSON object literal
 *
 * Returns:
 * - Parsed action data with no side effects
 */
export function tokenAct(): LlmStreamingControlParser<LlmStreamingControlTokenAct> {
  return {
    name: 'ACT',
    match(special) {
      const trimmed = special.trim()
      return trimmed.startsWith(actTokenPrefix) && trimmed.endsWith(markerSuffix)
    },
    parse(special) {
      const trimmed = special.trim()
      const rawPayload = trimmed.slice(actTokenPrefix.length, -markerSuffix.length).trim()

      const parsed = parseActPayload(rawPayload)
      if (!parsed)
        return undefined

      return {
        type: 'act',
        payload: parsed,
      }
    },
  }
}
