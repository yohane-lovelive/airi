import type { Intention, IntentionRequest, TalkControl, TalkLevelRequest } from '@proj-airi/core-agent'

import { applyTalkLevel, createIntention, openIntentions } from '@proj-airi/core-agent'
import { describe, expect, it, vi } from 'vitest'

import {
  ADD_INTENTION_TOOL_NAME,
  createIntentionTools,
  createTalkLevelTool,
  FINISH_INTENTION_TOOL_NAME,
  LIST_INTENTIONS_TOOL_NAME,
  SET_TALK_LEVEL_TOOL_NAME,
} from './initiative'

type Tools = Awaited<ReturnType<typeof createIntentionTools>>

function runner(tools: Tools) {
  return (name: string, input: unknown) => tools.find(tool => tool.function.name === name)!.execute(input, { messages: [], toolCallId: 'call-1' })
}

async function createIntentionHarness() {
  const intentions: Intention[] = []
  const add = vi.fn(async (request: IntentionRequest) => {
    const result = createIntention({ id: `i${intentions.length + 1}`, request, now: Date.now(), open: intentions })
    if (result.ok)
      intentions.push(result.intention)
    return result
  })
  const finish = vi.fn(async (id: string) => {
    const index = intentions.findIndex(intention => intention.id === id)
    if (index < 0)
      return false
    intentions.splice(index, 1)
    return true
  })
  const tools = await createIntentionTools({ open: () => openIntentions(intentions, Date.now()), add, finish })
  return { intentions, add, finish, run: runner(tools) }
}

async function createTalkHarness(answersOwner: boolean) {
  let control: TalkControl = {}
  let idleIntervalMinutes = 15
  const apply = vi.fn(async (request: TalkLevelRequest) => {
    const result = applyTalkLevel(control, request, Date.now())
    if (!result.ok)
      return result
    control = result.control
    if (result.permanentFactor)
      idleIntervalMinutes = Math.round(idleIntervalMinutes * result.permanentFactor)
    return { ok: true as const, control, idleIntervalMinutes }
  })
  const tools = await createTalkLevelTool({ answersOwner: () => answersOwner, apply })
  return { apply, run: runner(tools) }
}

describe('intention tools', () => {
  it('adds, lists, and finishes an intention', async () => {
    const harness = await createIntentionHarness()

    expect(await harness.run(ADD_INTENTION_TOOL_NAME, { text: 'Ask about the trip', hours: 24 })).toContain('i1: "Ask about the trip"')
    expect(await harness.run(LIST_INTENTIONS_TOOL_NAME, {})).toContain('i1: "Ask about the trip"')
    expect(await harness.run(FINISH_INTENTION_TOOL_NAME, { id: 'i1' })).toBe('Finished intention "i1".')
    expect(await harness.run(LIST_INTENTIONS_TOOL_NAME, {})).toBe('No open intentions.')
  })

  it('tells the model why an intention was not added', async () => {
    const harness = await createIntentionHarness()

    expect(await harness.run(ADD_INTENTION_TOOL_NAME, { text: 'Ask', hours: 500 })).toContain('Intention not added:')
    expect(harness.add).not.toHaveBeenCalled()

    for (let index = 0; index < 5; index++)
      await harness.run(ADD_INTENTION_TOOL_NAME, { text: `Idea ${index}`, hours: 1 })
    expect(await harness.run(ADD_INTENTION_TOOL_NAME, { text: 'One more', hours: 1 })).toContain('Finish one first.')
  })

  it('says when no open intention has the id', async () => {
    const harness = await createIntentionHarness()

    expect(await harness.run(FINISH_INTENTION_TOOL_NAME, { id: 'missing' })).toBe('No open intention with that id.')
  })
})

describe('talk level tool', () => {
  it('starts a quiet time in a reply to the owner', async () => {
    const harness = await createTalkHarness(true)

    const result = await harness.run(SET_TALK_LEVEL_TOOL_NAME, { kind: 'quiet', minutes: 30 })

    expect(harness.apply).toHaveBeenCalledWith({ kind: 'quiet', minutes: 30 })
    expect(result).toContain('Talk level changed.')
    expect(result).toContain('Quiet until')
  })

  it('changes the interval for good with 0 minutes, and ignores the minutes of normal', async () => {
    const harness = await createTalkHarness(true)

    expect(await harness.run(SET_TALK_LEVEL_TOOL_NAME, { kind: 'less', minutes: 0 })).toContain('about every 23 minutes')
    await harness.run(SET_TALK_LEVEL_TOOL_NAME, { kind: 'normal', minutes: 0 })
    expect(harness.apply).toHaveBeenLastCalledWith({ kind: 'normal' })
  })

  // Only the owner changes the talk level. An autonomous turn must not quiet or speed itself.
  it('refuses in a turn that does not answer the owner', async () => {
    const harness = await createTalkHarness(false)

    expect(await harness.run(SET_TALK_LEVEL_TOOL_NAME, { kind: 'more', minutes: 0 })).toContain('only the owner can change it')
    expect(harness.apply).not.toHaveBeenCalled()
  })

  it('tells the model why a request was refused', async () => {
    const harness = await createTalkHarness(true)

    expect(await harness.run(SET_TALK_LEVEL_TOOL_NAME, { kind: 'quiet', minutes: 0 })).toContain('Talk level not changed:')
    expect(await harness.run(SET_TALK_LEVEL_TOOL_NAME, { kind: 'quiet', minutes: 9_999 })).toContain('Talk level not changed:')
  })
})
