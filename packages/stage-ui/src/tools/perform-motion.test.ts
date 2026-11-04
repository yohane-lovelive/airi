import { describe, expect, it, vi } from 'vitest'

import { createPerformMotionTool, PERFORM_MOTION_TOOL_NAME } from './perform-motion'

async function harness(match: string | undefined, generate: { ok: true } | { ok: false, reason: string }) {
  const options = { match: vi.fn(() => match), generate: vi.fn(async () => generate) }
  const [tool] = await createPerformMotionTool(options)
  return { ...options, tool, run: (input: unknown) => tool.execute(input, { messages: [], toolCallId: 'call-1' }) }
}

describe('perform motion tool', () => {
  it('asks for an ACT marker when a gesture fits, so the gesture starts with the speech', async () => {
    const { run, generate, tool } = await harness('wave', { ok: true })

    expect(tool.function.name).toBe(PERFORM_MOTION_TOOL_NAME)
    expect(await run({ motion: ' wave hello ' })).toBe('A gesture fits: "wave". Write <|ACT {"motion":"wave"}|> in your reply where you do it.')
    expect(generate).not.toHaveBeenCalled()
  })

  it('keeps the marker valid JSON for a name with quotes', async () => {
    const { run } = await harness('say "yes"', { ok: true })

    const result = String(await run({ motion: 'say yes' }))
    const marker = result.match(/<\|ACT (.+)\|>/)![1]
    expect(JSON.parse(marker)).toEqual({ motion: 'say "yes"' })
  })

  it('starts a generation without a gesture, and asks for a short line without the motion', async () => {
    const { run, generate } = await harness(undefined, { ok: true })

    const result = await run({ motion: 'swing a sword' })

    expect(generate).toHaveBeenCalledWith('swing a sword')
    expect(result).toContain('the motion is being made now')
    expect(result).toContain('write no ACT motion for it')
  })

  it('gives the reason when no motion can be made', async () => {
    const { run } = await harness(undefined, { ok: false, reason: 'Motion generation is off.' })

    const result = await run({ motion: 'swing a sword' })

    expect(result).toContain('no motion can be made: Motion generation is off.')
    expect(result).toContain('Tell the owner briefly')
  })

  it('asks for the movement in English, because the generator reads English', async () => {
    const { tool } = await harness(undefined, { ok: true })

    const motion = (tool.function.parameters as { properties: { motion: { description: string } } }).properties.motion
    expect(motion.description).toContain('English sentence')
    expect(motion.description).toContain('Translate the owner\'s words')
  })

  it('refuses an empty motion', async () => {
    const { run, match } = await harness('wave', { ok: true })

    expect(await run({ motion: '' })).toContain('The motion is not valid')
    expect(match).not.toHaveBeenCalled()
  })
})
