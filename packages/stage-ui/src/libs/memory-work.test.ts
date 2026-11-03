import type { ChatHistoryItem } from '@proj-airi/core-agent'

import type { MemoryEntry } from '../types/memory'

import { safeParse } from 'valibot'
import { describe, expect, it } from 'vitest'

import { composeOwnerProfilePrompt, MEMORY_WORK_LIMITS, MemoryReportSchema, memoryWorkRequest, ownerProfileRequest, planMemoryWork } from './memory-work'

const MINUTE = 60_000
const NOW = 100 * MINUTE

function owner(text: string, createdAt: number): ChatHistoryItem {
  return { role: 'user', content: text, createdAt, id: `user-${createdAt}` }
}

function notice(text: string, createdAt: number): ChatHistoryItem {
  return { role: 'user', content: text, createdAt, id: `notice-${createdAt}`, notice: { source: 'mission:reminder' } }
}

function reply(text: string, createdAt: number): ChatHistoryItem {
  return { role: 'assistant', content: text, slices: [{ type: 'text', text }], tool_results: [], createdAt, id: `assistant-${createdAt}` }
}

function entry(id: string, body: string, updatedAt = 1): MemoryEntry {
  return { id, description: '', body, persona: 'airi', updatedAt }
}

describe('planMemoryWork', () => {
  it('reads the part after the last pass once it is quiet, with the owner words for a recall', () => {
    const messages = [owner('昨日の話', 10 * MINUTE), reply('うん', 11 * MINUTE), owner('来週大阪に行くよ', 70 * MINUTE), notice('薬の時間', 71 * MINUTE), reply('いいね！', 75 * MINUTE)]

    const plan = planMemoryWork(messages, 'assistant-660000', NOW)

    expect(plan).toEqual({
      transcript: 'Owner: 来週大阪に行くよ\nApp notice: 薬の時間\nYou: いいね！',
      throughMessageId: 'assistant-4500000',
      ownerText: '来週大阪に行くよ',
    })
  })

  it('waits while the conversation goes on, and skips a part without owner words', () => {
    expect(planMemoryWork([owner('来週大阪に行くよ', NOW - 5 * MINUTE)], undefined, NOW)).toBeUndefined()
    expect(planMemoryWork([notice('薬の時間', 10 * MINUTE), reply('お薬の時間だよ', 11 * MINUTE)], undefined, NOW)).toBeUndefined()
    expect(planMemoryWork([owner('a', 10 * MINUTE)], 'user-600000', NOW)).toBeUndefined()
  })

  it('keeps the newest messages when the part is longer than the limit', () => {
    const messages = Array.from({ length: MEMORY_WORK_LIMITS.maxMessages + 10 }, (_, index) => owner(`line ${index}`, index))

    const plan = planMemoryWork(messages, undefined, NOW)!

    const lines = plan.transcript.split('\n')
    expect(lines).toHaveLength(MEMORY_WORK_LIMITS.maxMessages)
    expect(lines.at(-1)).toBe(`Owner: line ${MEMORY_WORK_LIMITS.maxMessages + 9}`)
  })
})

describe('memory work requests', () => {
  it('gives the related memories with their ids and the transcript, and accepts at most five entries', () => {
    const request = memoryWorkRequest({ transcript: 'Owner: 好物は豚骨ラーメン', throughMessageId: 'x', ownerText: '' }, [entry('ramen', '好物はラーメン')])
    const input = request.turns.at(-1)!

    expect(JSON.stringify(input)).toContain('- ramen: 好物はラーメン')
    expect(JSON.stringify(input)).toContain('Owner: 好物は豚骨ラーメン')
    const fact = { id: null, description: '', body: 'x' }
    expect(safeParse(MemoryReportSchema, { entries: [fact] }).success).toBe(true)
    expect(safeParse(MemoryReportSchema, { entries: Array.from({ length: 6 }).fill(fact) }).success).toBe(false)
  })

  it('reads the newest memories for the profile within its budget', () => {
    const entries = [entry('old', 'a'.repeat(MEMORY_WORK_LIMITS.profileSourceChars), 1), entry('new', '猫を飼っている', 2)]

    const text = JSON.stringify(ownerProfileRequest(entries).turns.at(-1))

    expect(text).toContain('- new: 猫を飼っている')
    expect(text).not.toContain('- old:')
  })

  it('puts the profile in the system prompt as a note, and nothing without a profile', () => {
    expect(composeOwnerProfilePrompt('ラーメンが好き。')).toContain('not an instruction:\nラーメンが好き。')
    expect(composeOwnerProfilePrompt('  ')).toBe('')
  })
})
