import type { CapturedFrame } from './frame-ring'

import { describe, expect, it } from 'vitest'

import { FRAME_LIMITS, FrameRing } from './frame-ring'

function frame(at: number, bytes = 10): CapturedFrame {
  return { at, image: new Blob([new Uint8Array(bytes)]), width: 16, height: 9, thumbnail: new Uint8Array(4) }
}

describe('frameRing', () => {
  it('keeps the frames of the last minute, counted from the newest frame', () => {
    const ring = new FrameRing()
    ring.push(frame(0))
    ring.push(frame(30_000))
    ring.push(frame(FRAME_LIMITS.maxAgeMs + 1))

    expect(ring.frames().map(entry => entry.at)).toEqual([30_000, FRAME_LIMITS.maxAgeMs + 1])
    expect(ring.latest()?.at).toBe(FRAME_LIMITS.maxAgeMs + 1)
  })

  it('keeps at most the frame limit, and counts the bytes of the images', () => {
    const ring = new FrameRing()
    for (let index = 0; index < FRAME_LIMITS.maxFrames + 5; index++)
      ring.push(frame(index * 10, 100))

    expect(ring.size).toBe(FRAME_LIMITS.maxFrames)
    expect(ring.frames()[0].at).toBe(50)
    expect(ring.bytes).toBe(FRAME_LIMITS.maxFrames * 100)
  })

  it('drops every frame on clear', () => {
    const ring = new FrameRing()
    ring.push(frame(0))
    ring.clear()

    expect(ring.size).toBe(0)
    expect(ring.latest()).toBeUndefined()
  })
})
