import type { ReplayTurn } from './replay'

import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Transformer } from '@napi-rs/image'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { complete } from './chat'
import { renderContactSheet } from './contact-sheet'
import { parseJudgment } from './judge'
import { replayMetrics } from './metrics'
import { frameImage, loadRecording, loadRecordings } from './recording'
import { replayRecording, seededRandom, splitReply } from './replay'

const START = Date.UTC(2026, 10, 2, 10, 0, 0)
const MINUTE = 60_000

/** A thumbnail with a horizontal gradient. Two seeds give two clearly different scenes. */
function thumbnail(seed: number) {
  const pixels = new Uint8Array(64 * 36)
  for (let index = 0; index < pixels.length; index++)
    pixels[index] = (index % 64) * (seed + 1) * 3 % 256
  return Buffer.from(pixels).toString('base64')
}

/** Writes a recording of `minutes` at 2 frames each second: one scene, then a cut to another at the middle. */
async function writeRecording(root: string, minutes: number, ownerAt?: number) {
  const id = '2026-11-02T10-00-00'
  const directory = join(root, id)
  await mkdir(join(directory, 'frames'), { recursive: true })
  const count = minutes * 120
  const lines: string[] = []
  for (let index = 0; index < count; index++) {
    const file = `frames/${String(index + 1).padStart(6, '0')}.jpg`
    await writeFile(join(directory, file), Buffer.from([0xFF, 0xD8, index % 256]))
    lines.push(JSON.stringify({ at: START + index * 500, file, app: 'Game', thumbnail: thumbnail(index < count / 2 ? 1 : 7) }))
  }
  await writeFile(join(directory, 'frames.jsonl'), `${lines.join('\n')}\n`)
  await writeFile(join(directory, 'events.jsonl'), ownerAt !== undefined ? `${JSON.stringify({ kind: 'owner-message', at: ownerAt })}\n` : '')
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ id, startedAt: START, endedAt: START + minutes * MINUTE, frames: count, bytes: 0 }))
  return directory
}

describe('replayRecording', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'airi-replay-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads a recording with its thumbnails and owner messages, and the frame images', async () => {
    const directory = await writeRecording(root, 1, START + 10_000)
    const recording = loadRecording(directory)

    expect(recording.frames).toHaveLength(120)
    expect(recording.frames[0].thumbnail).toHaveLength(64 * 36)
    expect(recording.ownerMessages).toEqual([{ at: START + 10_000 }])
    expect(await frameImage(recording, recording.frames[0])).toBe(Buffer.from([0xFF, 0xD8, 0]).toString('base64'))
    expect(loadRecordings(root).map(entry => entry.id)).toEqual([recording.id])
  })

  it('detects the cut, starts commentary turns with frames, and keeps the timeline markers of the replies', async () => {
    const recording = loadRecording(await writeRecording(root, 4))
    const turns: ReplayTurn[] = []
    const result = await replayRecording(recording, { mode: 'commentary', policy: 'fresh-keyframes', seed: 1 }, async (turn) => {
      turns.push(turn)
      return { text: `Look at that! <|NOTE the scene changed|> <|SCENE a match|>`, usage: { input: 1_000, output: 20, cached: 400 } }
    })

    expect(result.events.some(event => event.type === 'scene-change')).toBe(true)
    expect(result.turns).toBeGreaterThan(0)
    expect(turns.every(turn => turn.frames.length >= 1 && turn.frames.length <= 2)).toBe(true)
    expect(turns[0].notice).toContain('Mode: commentary')
    expect(result.lines[0].text).toBe('Look at that!')
    expect(result.timeline.scene?.text).toBe('a match')
    expect(result.timeline.notes[0]?.text).toBe('the scene changed')
    // A later notice gives the timeline back to the model.
    expect(turns.at(-1)!.notice).toContain('Current scene')
  })

  it('makes the same decisions again with the same seed and replies', async () => {
    const recording = loadRecording(await writeRecording(root, 3))
    const speak = async () => ({ text: '' })
    const first = await replayRecording(recording, { mode: 'commentary', policy: 'fresh-keyframes', seed: 7 }, speak)
    const second = await replayRecording(recording, { mode: 'commentary', policy: 'fresh-keyframes', seed: 7 }, speak)

    expect(second.turns).toBe(first.turns)
    expect(first.silent).toBe(first.turns)
  })

  it('sends one contact sheet for each turn and counts it as one image', async () => {
    const recording = loadRecording(await writeRecording(root, 4))
    const turns: ReplayTurn[] = []
    const result = await replayRecording(recording, { mode: 'commentary', policy: 'contact-sheet', seed: 1 }, async (turn) => {
      turns.push(turn)
      return { text: 'Nice!' }
    })

    expect(turns.length).toBeGreaterThan(0)
    expect(turns.every(turn => turn.frames.length === 0 && turn.sheet!.length >= 1 && turn.sheet!.length <= 6)).toBe(true)
    expect(turns[0].notice).toContain('frames as tiles')
    expect(result.images).toBe(turns.length)
    expect(result.lines[0].frames).toEqual(turns[0].sheet)
  })

  it('keeps the anchor of the scene until the cut, and then takes the first frame after it', async () => {
    const recording = loadRecording(await writeRecording(root, 4))
    const turns: ReplayTurn[] = []
    const result = await replayRecording(recording, { mode: 'commentary', policy: 'scene-anchor', seed: 1 }, async (turn) => {
      turns.push(turn)
      return { text: '' }
    })

    const cut = result.events.find(event => event.type === 'scene-change')!.at
    const after = turns.filter(turn => turn.at > cut + 60_000)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every(turn => turn.anchor!.at >= cut && turn.anchor!.at === after[0].anchor!.at)).toBe(true)
    // In commentary two images go: the anchor and the newest frame.
    expect(turns.every(turn => turn.anchor !== undefined && turn.frames.length === 1)).toBe(true)
    expect(after[0].notice).toContain('anchor of the current scene')
  })
})

describe('renderContactSheet', () => {
  it('tiles the frames into one JPEG of the layout of the app', async () => {
    const pixels = new Uint8Array(640 * 360 * 4).fill(200)
    const jpeg = (await Transformer.fromRgbaPixels(pixels, 640, 360).jpeg(80)).toString('base64')

    const sheet = await renderContactSheet([jpeg, jpeg, jpeg, jpeg])
    const metadata = await new Transformer(Buffer.from(sheet, 'base64')).metadata()

    expect(metadata.format).toBe('jpeg')
    expect([metadata.width, metadata.height]).toEqual([3 * 426, 2 * 240])
  })
})

describe('replay helpers', () => {
  it('draws the same values for the same seed', () => {
    const left = seededRandom(3)
    const right = seededRandom(3)
    expect([left(), left(), left()]).toEqual([right(), right(), right()])
  })

  it('splits markers out of the spoken text', () => {
    expect(splitReply('Nice! <|ACT {"emotion":"happy"}|> <|NOTE boss down|><|TOPIC games|>')).toEqual({ spoken: 'Nice!', markers: [{ kind: 'note', text: 'boss down' }] })
  })

  it('measures turns, silence, images, and tokens, and the shares of the judgments', () => {
    const metrics = replayMetrics({
      durationMs: 2 * MINUTE,
      turns: 4,
      silent: 1,
      images: 6,
      usage: { input: 1_000, output: 50, cached: 250 },
      lines: [
        { at: 0, text: 'ラーメン食べたい', trigger: 'boredom', speechType: 'ask', frames: [] },
        { at: 1, text: 'ラーメン屋に行こう', trigger: 'event', speechType: 'react', frames: [] },
      ],
      events: [],
      timeline: { notes: [] },
    }, [{ grounded: true, contradicts: false }, { grounded: false, contradicts: true }])

    expect(metrics).toMatchObject({ turnsPerMinute: 2, silenceShare: 0.25, imagesPerHour: 180, cacheShare: 0.25, groundedShare: 0.5, contradictionShare: 0.5 })
    expect(metrics.topicSimilarity).toBeGreaterThan(0)
  })

  it('reads a judgment inside text or a code fence, and nothing from a broken answer', () => {
    expect(parseJudgment('```json\n{"grounded": true, "contradicts": false}\n```')).toEqual({ grounded: true, contradicts: false })
    expect(parseJudgment('no idea')).toBeUndefined()
    expect(parseJudgment('{"grounded": "yes"}')).toBeUndefined()
  })

  it('sends images as data URLs and reads the cached tokens of the response', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,AAAA')
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60 } } }))
    })
    vi.stubGlobal('fetch', fetch)
    try {
      const reply = await complete({ baseURL: 'https://example.test/v1/', apiKey: 'key', model: 'model' }, [
        { role: 'system', content: 'persona' },
        { role: 'user', content: [{ type: 'text', text: 'notice' }, { type: 'image', base64: 'AAAA' }] },
      ])
      expect(reply).toEqual({ text: 'hi', usage: { input: 100, output: 5, cached: 60 } })
      expect(fetch).toHaveBeenCalledWith('https://example.test/v1/chat/completions', expect.anything())
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
