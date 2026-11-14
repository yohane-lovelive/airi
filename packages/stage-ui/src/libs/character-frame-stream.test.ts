import type { CharacterFrame } from '@proj-airi/stage-shared/stage-sidecar'

import type { CharacterFrameStreamOptions } from './character-frame-stream'

import { parseHostMessage } from '@proj-airi/stage-shared/stage-sidecar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CharacterFrameStream } from './character-frame-stream'

const SILENT_MOUTH: CharacterFrame['mouth'] = { A: 0, E: 0, I: 0, O: 0, U: 0 }

describe('characterFrameStream', () => {
  let frames: CharacterFrame[] = []
  let stream: CharacterFrameStream | undefined

  function createStream(options: Partial<CharacterFrameStreamOptions> = {}) {
    stream = new CharacterFrameStream({
      readMouth: () => SILENT_MOUTH,
      readSpeechLevel: () => 0,
      isThinking: () => false,
      isBodyMotionEnabled: () => true,
      send: frame => frames.push(frame),
      ...options,
    })
    return stream
  }

  beforeEach(() => {
    vi.useFakeTimers()
    frames = []
  })

  afterEach(() => {
    stream?.stop()
    vi.useRealTimers()
  })

  it('sends about 30 frames each second', () => {
    createStream().start()

    vi.advanceTimersByTime(1000)

    expect(frames.length).toBeGreaterThanOrEqual(29)
    expect(frames.length).toBeLessThanOrEqual(31)
  })

  it('sends frames that the sidecar protocol accepts', () => {
    createStream({ readMouth: () => ({ A: 0.7, E: 0.2, I: 0, O: 0, U: 0 }), readSpeechLevel: () => 0.8, isThinking: () => true }).start()

    vi.advanceTimersByTime(2000)

    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames)
      expect(() => parseHostMessage({ type: 'host.character.frame', payload: frame })).not.toThrow()
  })

  it('moves the body while natural movement is on', () => {
    createStream().start()

    vi.advanceTimersByTime(1000)

    expect(frames.at(-1)!.bones.chest).not.toEqual({ x: 0, y: 0, z: 0 })
  })

  it('keeps the body still but the mouth moving while natural movement is off', () => {
    createStream({ isBodyMotionEnabled: () => false, readMouth: () => ({ A: 0.5, E: 0, I: 0, O: 0, U: 0 }) }).start()

    vi.advanceTimersByTime(1000)

    const frame = frames.at(-1)!
    expect(frame.bones.chest).toEqual({ x: 0, y: 0, z: 0 })
    expect(frame.bones.head).toEqual({ x: 0, y: 0, z: 0 })
    expect(frame.eyes).toEqual({ yaw: 0, pitch: 0 })
    expect(frame.mouth.A).toBe(0.5)
  })

  it('moves the eyes away while the chat model thinks', () => {
    createStream({ isThinking: () => true }).start()

    vi.advanceTimersByTime(2000)

    expect(frames.at(-1)!.eyes.yaw).not.toBe(0)
  })

  it('stops the frames, and can start again', () => {
    const instance = createStream()
    instance.start()
    vi.advanceTimersByTime(100)
    instance.stop()
    const count = frames.length

    vi.advanceTimersByTime(1000)
    expect(frames).toHaveLength(count)

    instance.start()
    vi.advanceTimersByTime(100)
    expect(frames.length).toBeGreaterThan(count)
  })

  it('keeps one set of ticks when start runs twice', () => {
    const instance = createStream()

    instance.start()
    instance.start()
    vi.advanceTimersByTime(1000)

    expect(frames.length).toBeLessThanOrEqual(31)
  })

  it('limits the time step of the first tick after a long gap', () => {
    const deltas: number[] = []
    createStream({
      readMouth: (delta) => {
        deltas.push(delta)
        return SILENT_MOUTH
      },
    }).start()

    vi.setSystemTime(Date.now() + 60_000)
    vi.advanceTimersByTime(60_000)

    expect(Math.max(...deltas)).toBeLessThanOrEqual(0.25)
  })
})
