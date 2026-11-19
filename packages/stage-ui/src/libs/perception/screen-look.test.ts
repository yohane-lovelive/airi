import type { CapturedFrame } from './frame-ring'
import type { ScreenLookDecide } from './screen-look'

import { DecisionRequestError, SCREEN_LOOK_QUESTIONS } from '@proj-airi/core-agent'
import { describe, expect, it, vi } from 'vitest'

import { SCREEN_LOOK_LIMITS, ScreenLook } from './screen-look'

function frame(at: number, text: string): CapturedFrame {
  return { at, image: new Blob([text], { type: 'image/jpeg' }), width: 4, height: 2, thumbnail: new Uint8Array(0) }
}

function answer(react: number, roster: number): Awaited<ReturnType<ScreenLookDecide>> {
  return { answers: { react: { probability: react }, roster: { probability: roster }, iconList: { probability: 0.05 } }, inputTokens: 890 }
}

describe('screen look', () => {
  it('asks both questions about the frame of the call before and the newest frame', async () => {
    const decide = vi.fn<ScreenLookDecide>(async () => answer(0.1, 0.9))
    const screenLook = new ScreenLook(decide)

    expect(await screenLook.look(frame(1_000, 'first'), 1_000)).toBeUndefined()
    expect(await screenLook.look(frame(3_000, 'second'), 3_000)).toEqual({ at: 3_000, react: 0.1, roster: 0.9, iconList: 0.05, inputTokens: 890 })

    expect(decide).toHaveBeenCalledTimes(1)
    const [input, questions] = decide.mock.calls[0]
    expect(questions).toBe(SCREEN_LOOK_QUESTIONS)
    expect(input.flatMap(part => part.type === 'image' ? [atob(part.data)] : [])).toEqual(['first', 'second'])
  })

  it('makes no request without a new frame, and none for two frames with a gap in the capture', async () => {
    const decide = vi.fn<ScreenLookDecide>(async () => answer(0, 0))
    const screenLook = new ScreenLook(decide)
    const first = frame(1_000, 'first')

    await screenLook.look(first, 1_000)
    expect(await screenLook.look(first, 3_000)).toBeUndefined()
    expect(await screenLook.look(undefined, 5_000)).toBeUndefined()
    const late = 1_000 + SCREEN_LOOK_LIMITS.maxFrameGapMs + 1
    expect(await screenLook.look(frame(late, 'late'), late)).toBeUndefined()
    expect(decide).not.toHaveBeenCalled()

    // The frame after the gap starts a new pair.
    expect(await screenLook.look(frame(late + 2_000, 'next'), late + 2_000)).toBeDefined()
  })

  it('starts a new pair after a reset', async () => {
    const decide = vi.fn<ScreenLookDecide>(async () => answer(0, 0))
    const screenLook = new ScreenLook(decide)

    await screenLook.look(frame(1_000, 'first'), 1_000)
    screenLook.reset()
    expect(await screenLook.look(frame(3_000, 'second'), 3_000)).toBeUndefined()
    expect(decide).not.toHaveBeenCalled()
  })

  it('rests after a failed request, shorter after a full rate limit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const decide = vi.fn<ScreenLookDecide>()
      .mockRejectedValueOnce(new DecisionRequestError(429, 'full'))
      .mockRejectedValueOnce(new Error('The decision model has no Gemini API key.'))
      .mockResolvedValue(answer(0.2, 0.1))
    const screenLook = new ScreenLook(decide)
    let at = 1_000
    const look = (now: number) => screenLook.look(frame(at += 500, 'frame'), now)

    await look(0)
    expect(await look(2_000)).toBeUndefined()
    expect(await look(4_000)).toBeUndefined()
    expect(decide).toHaveBeenCalledTimes(1)

    const afterRateLimit = 2_000 + SCREEN_LOOK_LIMITS.rateLimitRestMs
    expect(await look(afterRateLimit)).toBeUndefined()
    expect(decide).toHaveBeenCalledTimes(2)
    expect(await look(afterRateLimit + SCREEN_LOOK_LIMITS.rateLimitRestMs)).toBeUndefined()
    expect(decide).toHaveBeenCalledTimes(2)

    expect(await look(afterRateLimit + SCREEN_LOOK_LIMITS.failureRestMs)).toMatchObject({ react: 0.2, roster: 0.1 })
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('makes no second request while one is in flight', async () => {
    let release: (value: Awaited<ReturnType<ScreenLookDecide>>) => void = () => {}
    const decide = vi.fn<ScreenLookDecide>(() => new Promise((resolve) => {
      release = resolve
    }))
    const screenLook = new ScreenLook(decide)

    await screenLook.look(frame(1_000, 'first'), 1_000)
    const slow = screenLook.look(frame(3_000, 'second'), 3_000)
    // The request starts after the frames are read.
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    expect(await screenLook.look(frame(5_000, 'third'), 5_000)).toBeUndefined()
    release(answer(0.3, 0.3))

    expect(await slow).toMatchObject({ at: 3_000 })
    expect(decide).toHaveBeenCalledTimes(1)
  })
})
