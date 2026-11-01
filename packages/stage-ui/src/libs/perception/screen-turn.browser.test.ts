import type { ScreenEvent } from '@proj-airi/stage-shared/perception'

import type { CapturedFrame } from './frame-ring'

import { describe, expect, it } from 'vitest'

import { encodeFrame } from './encode-frame'
import { FRAME_LIMITS } from './frame-ring'
import { imageBudgetState } from './image-budget'
import { buildScreenTurn } from './screen-turn'

const NOW = 1_000_000

/** A real encoded frame of one flat color, 1600 by 900 pixels before scaling. */
async function frame(at: number, color: string): Promise<CapturedFrame> {
  const canvas = new OffscreenCanvas(1600, 900)
  const context = canvas.getContext('2d')!
  context.fillStyle = color
  context.fillRect(0, 0, 1600, 900)
  return encodeFrame(await createImageBitmap(canvas), at)
}

async function decodedWidth(base64: string) {
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
  const { width } = bitmap
  bitmap.close()
  return width
}

describe('buildScreenTurn', () => {
  it('attaches the newest frame at full size and the frame before an event smaller, with their ages', async () => {
    const frames = [await frame(NOW - 3_000, '#000000'), await frame(NOW - 2_500, '#000000'), await frame(NOW - 2_000, '#ffffff'), await frame(NOW - 500, '#ffffff')]
    const events: ScreenEvent[] = [{ type: 'scene-change', at: NOW - 1_000, salience: 0.8, magnitude: 0.9, familiar: false, app: 'Game' }]

    const turn = await buildScreenTurn({ frames, events, app: 'Game', budget: imageBudgetState([], 20, NOW), since: NOW - 10_000, now: NOW })

    expect(turn.context).toEqual({
      app: 'Game',
      frameAgesMs: [2_500, 500],
      events: [{ type: 'scene-change', ageMs: 1_000, app: 'Game' }],
    })
    expect(turn.attachments).toHaveLength(2)
    expect(turn.attachments.every(attachment => attachment.type === 'image' && attachment.mimeType === 'image/jpeg')).toBe(true)
    const [before, newest] = turn.attachments
    expect(await decodedWidth(before.data!)).toBe(FRAME_LIMITS.smallLongSide)
    expect(await decodedWidth(newest.data!)).toBe(FRAME_LIMITS.maxLongSide)
  })

  it('sends no frame and says so when the budget is used up', async () => {
    const frames = [await frame(NOW - 500, '#808080')]
    const sentAt = Array.from({ length: 20 }, (_, index) => NOW - index * 1_000)

    const turn = await buildScreenTurn({ frames, events: [], budget: imageBudgetState(sentAt, 20, NOW), since: NOW - 10_000, now: NOW })

    expect(turn.attachments).toEqual([])
    expect(turn.context).toEqual({ frameAgesMs: [], blind: 'budget', events: [] })
  })

  it('leaves out the events before the last turn', async () => {
    const frames = [await frame(NOW - 500, '#808080')]
    const events: ScreenEvent[] = [{ type: 'still', at: NOW - 20_000, salience: 0.1 }]

    const turn = await buildScreenTurn({ frames, events, budget: imageBudgetState([], 20, NOW), since: NOW - 10_000, now: NOW })

    expect(turn.context.events).toEqual([])
    expect(turn.attachments).toHaveLength(1)
  })
})
