import type { ScreenEvent } from './detectors'

import { describe, expect, it } from 'vitest'

import { DETECTOR_LIMITS, differenceHash, regionDiff, ScreenDetector, thumbnailDiff } from './detectors'

const WIDTH = 64
const HEIGHT = 36
const STEP = 500

/** A screen with a brightness gradient. Each seed gives another layout, and the hashes of different seeds differ. */
function screen(seed: number, shift = 0) {
  const pixels = new Uint8Array(WIDTH * HEIGHT)
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++)
      pixels[y * WIDTH + x] = (Math.floor(((x * (seed % 5 + 1)) + (y * (seed % 3 + 2)) * 3 + seed * 37) * 2.3) + shift) % 256
  }
  return pixels
}

/** Feeds the screens two frames each second and collects the events. */
function run(detector: ScreenDetector, screens: Array<{ thumbnail: Uint8Array, app?: string, frames?: number }>, start = 0) {
  const events: ScreenEvent[] = []
  let at = start
  for (const { thumbnail, app, frames = 1 } of screens) {
    for (let index = 0; index < frames; index++) {
      events.push(...detector.observe({ at, thumbnail, ...(app ? { app } : {}) }))
      at += STEP
    }
  }
  return { events, at }
}

function detector() {
  return new ScreenDetector({ width: WIDTH, height: HEIGHT })
}

describe('thumbnail comparison', () => {
  it('measures the mean change and gives near hashes for a small brightness shift', () => {
    expect(thumbnailDiff(new Uint8Array([0, 0]), new Uint8Array([255, 0]))).toBe(0.5)
    expect(thumbnailDiff(screen(1), screen(1))).toBe(0)
    expect(thumbnailDiff(screen(1), screen(2))).toBeGreaterThan(0.1)

    const base = differenceHash(screen(1), WIDTH, HEIGHT)
    const brighter = differenceHash(screen(1).map(value => Math.min(255, value + 3)), WIDTH, HEIGHT)
    const other = differenceHash(screen(2), WIDTH, HEIGHT)
    const distance = (left: Uint8Array, right: Uint8Array) => left.reduce((sum, bit, index) => sum + (bit === right[index] ? 0 : 1), 0)
    expect(distance(base, brighter)).toBeLessThanOrEqual(DETECTOR_LIMITS.familiarDistance)
    expect(distance(base, other)).toBeGreaterThan(DETECTOR_LIMITS.familiarDistance)
  })
})

describe('regionDiff', () => {
  it('measures the change inside the box only', () => {
    const before = new Uint8Array(WIDTH * HEIGHT)
    const after = new Uint8Array(WIDTH * HEIGHT)
    // Only the top left cell changes.
    for (let y = 0; y < HEIGHT / 3; y++) {
      for (let x = 0; x < WIDTH / 3; x++)
        after[y * WIDTH + x] = 255
    }

    expect(regionDiff(before, after, WIDTH, HEIGHT, { x: 0, y: 0, width: 1 / 3, height: 1 / 3 })).toBeGreaterThan(0.9)
    expect(regionDiff(before, after, WIDTH, HEIGHT, { x: 2 / 3, y: 2 / 3, width: 1 / 3, height: 1 / 3 })).toBe(0)
  })
})

describe('screenDetector', () => {
  it('reports one large scene change after the new screen settles', () => {
    const { events } = run(detector(), [{ thumbnail: screen(1), frames: 4 }, { thumbnail: screen(2), frames: 4 }])

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'scene-change', familiar: false })
    expect(events[0].salience).toBeGreaterThan(0.5)
  })

  it('waits through a flickering transition, and compares the end with the screen before it', () => {
    const { events } = run(detector(), [
      { thumbnail: screen(1), frames: 4 },
      { thumbnail: screen(7) },
      { thumbnail: screen(8) },
      { thumbnail: screen(7) },
      { thumbnail: screen(8) },
      { thumbnail: screen(2), frames: 4 },
    ])

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('scene-change')
    if (events[0].type === 'scene-change')
      expect(events[0].magnitude).toBeCloseTo(thumbnailDiff(screen(1), screen(2)))
  })

  it('ignores noise below the still threshold', () => {
    const { events } = run(detector(), [{ thumbnail: screen(1), frames: 4 }, { thumbnail: screen(1, 1), frames: 4 }, { thumbnail: screen(1), frames: 4 }])

    expect(events).toEqual([])
  })

  it('gives a familiar screen, for example a menu that opens again, a low salience', () => {
    const { events } = run(detector(), [
      { thumbnail: screen(1), frames: 4 },
      { thumbnail: screen(2), frames: 4 },
      { thumbnail: screen(1), frames: 4 },
      { thumbnail: screen(2), frames: 4 },
    ])
    const changes = events.filter(event => event.type === 'scene-change')

    expect(changes.map(event => event.type === 'scene-change' && event.familiar)).toEqual([false, true, true])
    expect(changes[2].salience).toBeLessThan(changes[0].salience * DETECTOR_LIMITS.familiarFactor + 0.01)
  })

  it('learns the usual change of an app, so the same change weighs less over time', () => {
    const screens = Array.from({ length: 12 }, (_, index) => ({ thumbnail: screen(10 + index), app: 'Video', frames: 3 }))
    const { events } = run(new ScreenDetector({ width: WIDTH, height: HEIGHT, limits: { familiarDistance: -1 } }), screens)
    const saliences = events.filter(event => event.type === 'scene-change').map(event => event.salience)

    expect(saliences.length).toBeGreaterThan(5)
    expect(saliences.at(-1)!).toBeLessThan(saliences[0])
  })

  it('reports an app switch after the dwell time, and not the screen change of the switch itself', () => {
    const dwellFrames = DETECTOR_LIMITS.appDwellMs / STEP + 1
    const { events } = run(detector(), [
      { thumbnail: screen(1), app: 'Code', frames: 4 },
      { thumbnail: screen(2), app: 'Game', frames: dwellFrames },
    ])

    expect(events).toEqual([expect.objectContaining({ type: 'app-switch', app: 'Game', from: 'Code', salience: DETECTOR_LIMITS.appSwitchSalience })])
  })

  it('does not report a short visit to another app, and gives the desktop a low salience', () => {
    const quick = run(detector(), [
      { thumbnail: screen(1), app: 'Code', frames: 4 },
      { thumbnail: screen(1), app: 'Slack', frames: 2 },
      { thumbnail: screen(1), app: 'Code', frames: 4 },
    ])
    expect(quick.events).toEqual([])

    const desktop = run(detector(), [
      { thumbnail: screen(1), app: 'Code', frames: 4 },
      { thumbnail: screen(1), app: 'Windows Explorer', frames: DETECTOR_LIMITS.appDwellMs / STEP + 1 },
    ])
    expect(desktop.events).toEqual([expect.objectContaining({ type: 'app-switch', salience: DETECTOR_LIMITS.quietAppSalience })])
  })

  it('reports a long still period once', () => {
    const frames = DETECTOR_LIMITS.longStillMs / STEP + 4
    const { events } = run(detector(), [{ thumbnail: screen(1), app: 'Reader', frames }])

    expect(events).toEqual([expect.objectContaining({ type: 'still', app: 'Reader', salience: DETECTOR_LIMITS.stillSalience })])
  })

  it('does not compare across a skipped frame of an excluded window', () => {
    const screens = detector()
    const before = run(screens, [{ thumbnail: screen(1), frames: 4 }])
    screens.skip(before.at)
    const after = run(screens, [{ thumbnail: screen(2), frames: 4 }], before.at + STEP)

    expect(after.events).toEqual([])
  })

  it('settles an animated screen that never stops, and still reports a cut to another scene', () => {
    // Two near frames alternate all the time, like an animated game lobby.
    const animated = (seed: number) => Array.from({ length: 2 }, (_, index) => ({ thumbnail: screen(seed, index * 10) }))
    const lobby = Array.from({ length: 60 }, () => animated(1)).flat()
    const screens = detector()
    const before = run(screens, lobby)
    expect(before.events).toEqual([])
    expect(screens.noise).toBeGreaterThan(DETECTOR_LIMITS.stillDiff)

    const after = run(screens, Array.from({ length: 6 }, () => animated(2)).flat(), before.at)
    expect(after.events).toEqual([expect.objectContaining({ type: 'scene-change' })])
  })

  it('raises the activity while the screen moves, and lowers it when the screen is still', () => {
    const screens = detector()
    const moving = run(screens, Array.from({ length: 20 }, (_, index) => ({ thumbnail: screen(index % 2 ? 1 : 2) })))
    const busy = screens.activity
    run(screens, [{ thumbnail: screen(1), frames: 40 }], moving.at)

    expect(busy).toBeGreaterThan(0.5)
    expect(screens.activity).toBeLessThan(busy / 4)
  })
})
