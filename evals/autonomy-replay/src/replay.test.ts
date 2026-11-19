import type { ReplayTurn } from './replay'

import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Transformer } from '@napi-rs/image'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { complete, sessionHeaders } from './chat'
import { renderContactSheet, scaleFrame } from './contact-sheet'
import { judgeMessages, parseJudgment } from './judge'
import { replayMetrics } from './metrics'
import { frameImage, loadCast, loadRecording, loadRecordings } from './recording'
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
    expect(turns[0].notice).toContain('Mode: you talk about the owner\'s screen.')
    expect(result.lines[0].text).toBe('Look at that!')
    expect(result.timeline.scene?.text).toBe('a match')
    expect(result.timeline.notes[0]?.text).toBe('the scene changed')
    // A later notice gives the timeline back to the model.
    expect(turns.at(-1)!.notice).toContain('Current scene')
  })

  it('names NEXT as the end marker of each reply, and counts the cut replies and the lines without the marker', async () => {
    const recording = loadRecording(await writeRecording(root, 4))
    const turns: ReplayTurn[] = []
    const result = await replayRecording(recording, { mode: 'commentary', policy: 'fresh-keyframes', seed: 1 }, async (turn) => {
      turns.push(turn)
      // The first reply was cut after its marker. The second has no marker.
      return turns.length === 1 ? { text: 'Look! <|NEXT wait|>', cut: true } : { text: 'And again.' }
    })

    expect(turns.every(turn => turn.endMarker === 'NEXT')).toBe(true)
    expect(result.cuts).toBe(1)
    expect(result.missingEnd).toBe(result.lines.length - 1)
  })

  it('sends a sheet of the seconds before a turn with its newest frame for the recent sheet, and keeps the cast of a reply', async () => {
    const recording = loadRecording(await writeRecording(root, 4))
    const turns: ReplayTurn[] = []
    const result = await replayRecording(recording, { mode: 'commentary', policy: 'recent-sheet', seed: 1 }, async (turn) => {
      turns.push(turn)
      return { text: 'Look! <|CAST the owner plays Ambessa|><|NEXT wait|>' }
    })

    const late = turns.at(-1)!
    expect(late.frames).toHaveLength(1)
    expect(late.frames[0].at).toBe(late.at)
    // Six tiles, 2 seconds apart, and the newest one is 2 seconds before the turn.
    expect(late.sheet!.map(tile => late.at - tile.at)).toEqual([12_000, 10_000, 8_000, 6_000, 4_000, 2_000])
    expect(late.notice).toContain('A contact sheet is attached: one image with 6 frames as tiles')
    expect(result.timeline.cast?.text).toBe('the owner plays Ambessa')
    expect(late.notice).toContain('Cast of the scene')
  })

  it('starts with the cast that a person wrote into the recording, and has none without the file', async () => {
    const directory = await writeRecording(root, 4)
    const recording = loadRecording(directory)
    expect(loadCast(recording)).toBeUndefined()
    await writeFile(join(directory, 'cast.txt'), 'The owner plays Ambessa.\nAllies: Karma.\n')
    const turns: ReplayTurn[] = []

    await replayRecording(recording, { mode: 'commentary', policy: 'recent-sheet', seed: 1, cast: loadCast(recording)! }, async (turn) => {
      turns.push(turn)
      return { text: 'Look! <|NEXT wait|>' }
    })

    expect(loadCast(recording)).toBe('The owner plays Ambessa. Allies: Karma.')
    expect(turns[0].notice).toContain('Cast of the scene, written')
    expect(turns[0].notice).toContain('The owner plays Ambessa. Allies: Karma.')
  })

  it('gives the player names of the owner to a turn until a reply wrote the cast', async () => {
    const recording = loadRecording(await writeRecording(root, 4))
    const turns: ReplayTurn[] = []

    await replayRecording(recording, { mode: 'commentary', policy: 'recent-sheet', seed: 1, ownerAccounts: ['Game: playername'] }, async (turn) => {
      turns.push(turn)
      return { text: turns.length === 1 ? 'Look! <|NEXT wait|>' : 'There! <|CAST The owner plays Ambessa.|><|NEXT wait|>' }
    })

    expect(turns.length).toBeGreaterThan(2)
    expect(turns[0].notice).toContain('- The owner\'s player names in games: Game: playername.')
    expect(turns[1].notice).toContain('player names in games')
    expect(turns[2].notice).not.toContain('player names in games')
    expect(turns[2].notice).toContain('Cast of the scene')
  })

  describe('cast reads', () => {
    /** Looks one step apart from the start. The first ones show a roster screen. */
    function looksOf(rosterLooks: number, count = 40) {
      return Array.from({ length: count }, (_, index) => ({ at: START + (index + 1) * 2_000, roster: index < rosterLooks ? 0.9 : 0.1 }))
    }

    it('reads the cast from a roster screen in a turn of its own, and later notices hold that cast', async () => {
      const recording = loadRecording(await writeRecording(root, 4))
      const turns: ReplayTurn[] = []

      const result = await replayRecording(recording, { mode: 'commentary', policy: 'recent-sheet', seed: 1, ownerAccounts: ['Game: playername'], looks: looksOf(10) }, async (turn) => {
        turns.push(turn)
        return { text: turn.castRead ? '<|CAST The owner plays Ambessa.|><|NEXT done|>' : 'Look! <|NEXT wait|>' }
      })

      const reads = turns.filter(turn => turn.castRead)
      expect(reads).toHaveLength(1)
      // The first look finds the roster screen, long before the first turn of the policy.
      expect(turns[0]).toBe(reads[0])
      expect(reads[0].at).toBe(START + 2_000)
      expect(reads[0].frames.map(frame => frame.at)).toEqual([START + 2_000])
      expect(reads[0].sheet).toBeUndefined()
      expect(reads[0].endMarker).toBe('NEXT')
      expect(reads[0].notice.split('\n')[0]).toContain('Silent turn')
      // Code finds the owner in the roster, so the read gets no player name of the owner.
      expect(reads[0].notice).not.toContain('playername')
      expect(turns[1].notice).toContain('Cast of the scene')
      expect(turns[1].notice).toContain('The owner plays Ambessa.')
      // With the looks, a turn of the policy writes no cast. The cast reads keep it.
      expect(turns[1].notice).not.toContain('<|CAST')
      expect(result).toMatchObject({ castReads: 1, castWrites: 1, castReadsSpoken: 0, turns: turns.length - 1 })
      expect(result.timeline.cast).toEqual({ text: 'The owner plays Ambessa.', at: START + 2_000 })
    })

    it('finds the owner and the two sides in the roster of a read, and keeps the cast at a later roster of the same people', async () => {
      const recording = loadRecording(await writeRecording(root, 2))
      const roster = '<|CAST\nGroup 1: Karma (kiki), Leona (taro)\nGroup 2: Ambessa (playername), Jinx (nana)\n|><|NEXT done|>'
      // The roster screen shows, goes away, and comes back: two reads.
      const looks = Array.from({ length: 40 }, (_, index) => ({ at: START + (index + 1) * 2_000, roster: index < 3 || (index >= 10 && index < 13) ? 0.9 : 0.1 }))

      const result = await replayRecording(recording, { mode: 'commentary', policy: 'recent-sheet', seed: 1, ownerAccounts: ['Game: playername'], looks }, async turn => ({
        text: turn.castRead ? roster : '<|NEXT done|>',
      }))

      expect(result).toMatchObject({ castReads: 2, castWrites: 1 })
      expect(result.timeline.cast).toEqual({ text: 'The owner plays Ambessa (playername). Allies: Jinx (nana). Opponents: Karma (kiki), Leona (taro).', at: START + 2_000 })
    })

    it('reads once more when the first read wrote no cast, and then leaves the roster screen alone', async () => {
      const recording = loadRecording(await writeRecording(root, 2))
      const reads: ReplayTurn[] = []

      const result = await replayRecording(recording, { mode: 'commentary', policy: 'recent-sheet', seed: 1, looks: looksOf(30) }, async (turn) => {
        if (turn.castRead)
          reads.push(turn)
        // A line of the policy stays silent here, so no speech holds a read.
        return { text: '<|NEXT done|>' }
      })

      expect(reads.map(turn => turn.at)).toEqual([START + 2_000, START + 10_000])
      expect(result).toMatchObject({ castReads: 2, castWrites: 0 })
      expect(result.timeline.cast).toBeUndefined()
    })

    it('runs no cast read without looks, and none while the looks show the play', async () => {
      const recording = loadRecording(await writeRecording(root, 2))
      const speak = async (turn: ReplayTurn) => {
        expect(turn.castRead).toBeUndefined()
        return { text: 'Look! <|NEXT wait|>' }
      }

      expect((await replayRecording(recording, { mode: 'commentary', policy: 'recent-sheet', seed: 1 }, speak)).castReads).toBe(0)
      expect((await replayRecording(recording, { mode: 'commentary', policy: 'recent-sheet', seed: 1, looks: looksOf(0) }, speak)).castReads).toBe(0)
    })
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

describe('scaleFrame', () => {
  it('scales a large frame down to the long side, and keeps a small frame as it is', async () => {
    const pixels = new Uint8Array(1280 * 720 * 4).fill(200)
    const large = (await Transformer.fromRgbaPixels(pixels, 1280, 720).jpeg(80)).toString('base64')

    const small = await scaleFrame(large, 512)
    const metadata = await new Transformer(Buffer.from(small, 'base64')).metadata()

    expect([metadata.width, metadata.height]).toEqual([512, 288])
    expect(await scaleFrame(small, 512)).toBe(small)
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
      requests: 5,
      toolCalls: 1,
      cuts: 0,
      missingEnd: 0,
      castReads: 0,
      castWrites: 0,
      castReadsSpoken: 0,
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
    expect(metrics.inputTokensPerLine).toBe(500)
    expect(metrics.outputTokensPerLine).toBe(25)
    expect(metrics.requestsPerTurn).toBe(1.25)
    expect(metrics.toolCalls).toBe(1)
  })

  it('measures the time to the first text of the lines: the median, and the time that 9 of 10 lines stay under', () => {
    const line = (firstTextMs: number | undefined) => ({ at: 0, text: `line ${firstTextMs}`, trigger: 'event' as const, frames: [], ...(firstTextMs !== undefined ? { firstTextMs } : {}) })
    const metrics = replayMetrics({
      durationMs: MINUTE,
      turns: 10,
      silent: 0,
      images: 0,
      requests: 10,
      toolCalls: 0,
      cuts: 0,
      missingEnd: 0,
      castReads: 0,
      castWrites: 0,
      castReadsSpoken: 0,
      usage: { input: 0, output: 0, cached: 0 },
      // A line of a fake model has no time, and it does not count.
      lines: [900, 1_000, 1_100, 1_200, 1_300, 1_400, 1_500, 1_600, 1_700, 4_000, undefined].map(line),
      events: [],
      timeline: { notes: [] },
    })

    expect(metrics.firstTextMsMedian).toBe(1_300)
    expect(metrics.firstTextMsSlow).toBe(1_700)
  })

  it('counts a line as a repeat when it is close to one of the three lines before it', () => {
    const texts = ['敵を倒したね、すごい！', 'ショップを開いたね', 'レベルが上がったよ', '敵を倒したね、すごい！', 'そろそろ集団戦かな', '次のオーグメントは何にする？', 'タワーが折れそう', '敵を倒したね、すごい！']
    const metrics = replayMetrics({
      durationMs: MINUTE,
      turns: texts.length,
      silent: 0,
      images: 0,
      requests: texts.length,
      toolCalls: 0,
      cuts: 0,
      missingEnd: 0,
      castReads: 0,
      castWrites: 0,
      castReadsSpoken: 0,
      usage: { input: 0, output: 0, cached: 0 },
      lines: texts.map((text, index) => ({ at: index, text, trigger: 'event' as const, frames: [] })),
      events: [],
      timeline: { notes: [] },
    })

    // The fourth line repeats the first one. The last line comes four lines after its twin, so it is no repeat.
    expect(metrics.repeatShare).toBe(1 / texts.length)
  })

  it('shows a line of a model that did not stop by the length of the longest line', () => {
    const texts = ['ナイス！', 'いい感じだね。', `${'敵を倒したね。'.repeat(500)}`]
    const metrics = replayMetrics({
      durationMs: MINUTE,
      turns: texts.length,
      silent: 0,
      images: 0,
      requests: texts.length,
      toolCalls: 0,
      cuts: 0,
      missingEnd: 0,
      castReads: 0,
      castWrites: 0,
      castReadsSpoken: 0,
      usage: { input: 0, output: 3_000, cached: 0 },
      lines: texts.map((text, index) => ({ at: index, text, trigger: 'event' as const, frames: [] })),
      events: [],
      timeline: { notes: [] },
    })

    expect(metrics.lineCharsMedian).toBe(7)
    expect(metrics.lineCharsMax).toBe(3_500)
    expect(metrics.outputTokensPerLine).toBe(1_000)
  })

  it('measures the share of cut turns and the share of lines without an end marker', () => {
    const metrics = replayMetrics({
      durationMs: MINUTE,
      turns: 10,
      silent: 6,
      images: 0,
      requests: 10,
      toolCalls: 0,
      cuts: 2,
      missingEnd: 1,
      castReads: 0,
      castWrites: 0,
      castReadsSpoken: 0,
      usage: { input: 0, output: 0, cached: 0 },
      lines: ['a', 'b', 'c', 'd'].map((text, index) => ({ at: index, text, trigger: 'event' as const, frames: [] })),
      events: [],
      timeline: { notes: [] },
    })

    expect(metrics.cutShare).toBe(0.2)
    expect(metrics.missingEndShare).toBe(0.25)
  })

  it('measures the share of lines with a score, with a name, and with a wrong name', () => {
    const texts = ['24対25の接戦だね。', 'スコアは３－２、まだ分からないよ。', 'アンベッサがレオナに飛び込んだ！', '試合時間は5:23、いい位置だね。']
    const metrics = replayMetrics({
      durationMs: MINUTE,
      turns: texts.length,
      silent: 0,
      images: 0,
      requests: texts.length,
      toolCalls: 0,
      cuts: 0,
      missingEnd: 0,
      castReads: 0,
      castWrites: 0,
      castReadsSpoken: 0,
      usage: { input: 0, output: 0, cached: 0 },
      lines: texts.map((text, index) => ({ at: index, text, trigger: 'event' as const, frames: [] })),
      events: [],
      timeline: { notes: [] },
    }, [
      { grounded: true, contradicts: false, names: 0, wrongNames: 0 },
      { grounded: true, contradicts: false },
      { grounded: true, contradicts: false, names: 2, wrongNames: 1 },
      { grounded: true, contradicts: false, names: 0, wrongNames: 0 },
    ])

    // The clock of the last line is no score.
    expect(metrics.scoreShare).toBe(0.5)
    expect(metrics.namedShare).toBe(0.25)
    expect(metrics.wrongNameShare).toBe(0.25)
  })

  it('gives the judge the cast of the scene, and reads the counts of names from its answer', () => {
    const [, user] = judgeMessages({ line: 'アンベッサが飛び込んだ！', images: [], timeline: { notes: [], cast: { text: 'the owner plays Ambessa', at: 1 } } })

    expect(JSON.stringify(user.content)).toContain('Cast of the scene: the owner plays Ambessa')
    expect(parseJudgment('{"grounded": true, "contradicts": false, "names": 1, "wrongNames": 0}')).toEqual({ grounded: true, contradicts: false, names: 1, wrongNames: 0 })
    expect(parseJudgment('{"grounded": true, "contradicts": false, "names": -1}')).toBeUndefined()
  })

  it('reads a judgment inside text or a code fence, and nothing from a broken answer', () => {
    expect(parseJudgment('```json\n{"grounded": true, "contradicts": false}\n```')).toEqual({ grounded: true, contradicts: false })
    expect(parseJudgment('no idea')).toBeUndefined()
    expect(parseJudgment('{"grounded": "yes"}')).toBeUndefined()
  })

  it('sends images as data URLs with the session header, and reads the cached tokens of the response', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,AAAA')
      expect(new Headers(init.headers).get('x-opencode-session')).toBe('judge-1')
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60 } } }))
    })
    vi.stubGlobal('fetch', fetch)
    try {
      const reply = await complete({ baseURL: 'https://example.test/v1/', apiKey: 'key', model: 'model', headers: sessionHeaders('judge-1') }, [
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
