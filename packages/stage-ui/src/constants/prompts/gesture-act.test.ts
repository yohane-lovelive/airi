import { describe, expect, it } from 'vitest'

import { formatGestureActPrompt, GESTURE_PROMPT_LIMIT } from './gesture-act'

function entry(name: string, useCount = 0, enabled = true) {
  return { name, description: `${name} description.`, useCount, enabled }
}

describe('gesture ACT prompt', () => {
  it('returns an empty prompt without an enabled gesture', () => {
    expect(formatGestureActPrompt([])).toBe('')
    expect(formatGestureActPrompt([entry('wave', 0, false)])).toBe('')
  })

  it('lists the enabled gestures by name with an ACT example', () => {
    const prompt = formatGestureActPrompt([entry('nod'), entry('wave', 0, false), entry('bow')])

    expect(prompt).toContain('<|ACT {"emotion":"happy","motion":"nod"}|>')
    expect(prompt).toContain('- "nod": nod description.\n- "bow": bow description.')
    expect(prompt).not.toContain('"wave"')
  })

  it('lists the most used gestures in the order of the library, so a use does not change the prompt', () => {
    const entries = Array.from({ length: GESTURE_PROMPT_LIMIT + 2 }, (_, index) => entry(`clip-${index}`, index === 0 ? 0 : 10))
    entries[1] = entry('clip-1', 1)

    const prompt = formatGestureActPrompt(entries)
    const listed = prompt.split('\n').filter(line => line.startsWith('- '))

    expect(listed).toHaveLength(GESTURE_PROMPT_LIMIT)
    expect(prompt).not.toContain('"clip-0"')
    expect(prompt).not.toContain('"clip-1"')
    expect(listed[0]).toContain('"clip-2"')
    // One more use of a listed clip keeps the same text.
    entries[5] = entry('clip-5', 11)
    expect(formatGestureActPrompt(entries)).toBe(prompt)
  })
})
