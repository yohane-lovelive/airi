import type { GateAsk, GateLook } from './gate'

import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DecisionRequestError } from '@proj-airi/core-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadGateLabels, scoreGate, screenLookAsk, traceGate } from './gate'
import { loadRecording } from './recording'

const START = Date.UTC(2026, 10, 12, 13, 0, 0)

/** Writes a recording of `seconds` at 2 frames each second. The bytes of each frame name its index. */
async function writeRecording(root: string, seconds: number, labels?: unknown) {
  const directory = join(root, 'match')
  await mkdir(join(directory, 'frames'), { recursive: true })
  const lines: string[] = []
  for (let index = 0; index <= seconds * 2; index++) {
    const file = `frames/${String(index + 1).padStart(6, '0')}.jpg`
    await writeFile(join(directory, file), Buffer.from(`frame-${index}`))
    lines.push(JSON.stringify({ at: START + index * 500, file, thumbnail: '' }))
  }
  await writeFile(join(directory, 'frames.jsonl'), `${lines.join('\n')}\n`)
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ id: 'match', startedAt: START, endedAt: START + seconds * 1000, frames: lines.length, bytes: 0 }))
  if (labels)
    await writeFile(join(directory, 'labels.json'), JSON.stringify(labels))
  return loadRecording(directory)
}

function frameOf(index: number) {
  return Buffer.from(`frame-${index}`).toString('base64')
}

/** The decision model is the boundary. The fake answers with a fixed chance. */
function askOf(probability = 0.5) {
  return vi.fn<GateAsk>(async () => ({ probability, roster: 0.1, inputTokens: 748 }))
}

function looksOf(probabilities: number[]): GateLook[] {
  return probabilities.map((probability, index) => ({ at: START + (index + 1) * 2_000, probability, roster: 0.1, inputTokens: 748 }))
}

describe('traceGate', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'airi-gate-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('looks once each 2 seconds, with the frame of the look before and the current frame', async () => {
    const recording = await writeRecording(root, 6)
    const ask = askOf(0.8)

    const looks = await traceGate(recording, { ask, minIntervalMs: 0 })

    expect(looks).toEqual([
      { at: START + 2_000, probability: 0.8, roster: 0.1, inputTokens: 748 },
      { at: START + 4_000, probability: 0.8, roster: 0.1, inputTokens: 748 },
      { at: START + 6_000, probability: 0.8, roster: 0.1, inputTokens: 748 },
    ])
    expect(ask.mock.calls.map(call => [call[0], call[1]])).toEqual([
      [frameOf(0), frameOf(4)],
      [frameOf(4), frameOf(8)],
      [frameOf(8), frameOf(12)],
    ])
  })

  it('asks the react question and the roster question in one request of the decision model', async () => {
    const decide = vi.fn(async () => ({ answers: { react: { probability: 0.2 }, roster: { probability: 0.9 } }, inputTokens: 890 }))

    const answer = await screenLookAsk({ decide: decide as never })('EARLIER', 'CURRENT')

    expect(answer).toEqual({ probability: 0.2, roster: 0.9, inputTokens: 890 })
    expect(decide).toHaveBeenCalledTimes(1)
    expect(Object.keys(decide.mock.calls[0].at(1) ?? {})).toEqual(['react', 'roster'])
  })

  it('asks nothing again on a second run, because the looks are saved in the recording folder', async () => {
    const recording = await writeRecording(root, 6)
    const first = await traceGate(recording, { ask: askOf(0.8), minIntervalMs: 0 })
    const ask = askOf(0.1)

    const second = await traceGate(recording, { ask, minIntervalMs: 0 })

    expect(ask).not.toHaveBeenCalled()
    expect(second).toEqual(first)
  })

  it('keeps the looks before a failure, and the next run asks only for the rest', async () => {
    const recording = await writeRecording(root, 6)
    const failing = vi.fn<GateAsk>()
      .mockResolvedValueOnce({ probability: 0.8, roster: 0.1, inputTokens: 748 })
      .mockRejectedValue(new DecisionRequestError(400, 'The decision model answered HTTP 400'))
    await expect(traceGate(recording, { ask: failing, minIntervalMs: 0 })).rejects.toThrow('HTTP 400')
    const ask = askOf(0.2)

    const looks = await traceGate(recording, { ask, minIntervalMs: 0 })

    expect(ask).toHaveBeenCalledTimes(2)
    expect(looks.map(look => look.probability)).toEqual([0.8, 0.2, 0.2])
  })

  it('waits and asks again after a server error', async () => {
    vi.useFakeTimers()
    try {
      const recording = await writeRecording(root, 2)
      const ask = vi.fn<GateAsk>()
        .mockRejectedValueOnce(new DecisionRequestError(503, 'The decision model answered HTTP 503'))
        .mockResolvedValue({ probability: 0.6, roster: 0.1, inputTokens: 748 })

      const trace = traceGate(recording, { ask, minIntervalMs: 0 })
      await vi.advanceTimersByTimeAsync(3_000)

      expect((await trace).map(look => look.probability)).toEqual([0.6])
      expect(ask).toHaveBeenCalledTimes(2)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('starts the saved looks again when the question changed', async () => {
    const recording = await writeRecording(root, 4)
    await traceGate(recording, { ask: askOf(0.8), minIntervalMs: 0 })
    const path = join(recording.directory, 'gate-trace.json')
    await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), question: 'an older question' }))
    const ask = askOf(0.3)

    const looks = await traceGate(recording, { ask, minIntervalMs: 0 })

    expect(ask).toHaveBeenCalledTimes(2)
    expect(looks.map(look => look.probability)).toEqual([0.3, 0.3])
  })
})

describe('loadGateLabels', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'airi-gate-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads the labels of a recording, and an event without the mark is not important', async () => {
    const recording = await writeRecording(root, 2, { events: [{ at: 32, type: 'kill', important: true }, { at: 40, type: 'banner', text: 'a notice' }] })

    expect(loadGateLabels(recording)).toEqual([{ at: 32, type: 'kill', important: true }, { at: 40, type: 'banner', important: false }])
  })

  it('gives nothing for a recording without labels', async () => {
    expect(loadGateLabels(await writeRecording(root, 2))).toBeUndefined()
  })
})

describe('scoreGate', () => {
  // Ten looks, from second 2 to second 20. The gate passes at seconds 4, 6, 12, and 20.
  const looks = looksOf([0.1, 0.9, 0.8, 0.1, 0.2, 0.75, 0.3, 0.1, 0.1, 0.95])
  const labels = [
    // In the step before the pass at second 4.
    { at: 3, type: 'kill', important: true },
    // At the time of the pass at second 12.
    { at: 12, type: 'death', important: true },
    // No pass in the 2 seconds after it.
    { at: 15, type: 'kill', important: true },
    // Caught by the pass at second 20, but not important.
    { at: 19, type: 'banner', important: false },
  ]

  it('counts the passes for each minute, and the lines that a gap of 6 seconds leaves', () => {
    const score = scoreGate(looks, undefined, { startedAt: START, threshold: 0.7 })

    // Twenty seconds of looks. The pass at second 6 comes 2 seconds after a line, so it starts none.
    expect(score.passesPerMinute).toBe(12)
    expect(score.linesPerMinute).toBe(9)
    expect(score.recall).toBeUndefined()
  })

  it('gives the share of important events that a pass caught, and the share of passes at an event', () => {
    const score = scoreGate(looks, labels, { startedAt: START, threshold: 0.7 })

    expect(score.recall).toBe(2 / 3)
    expect(score.precision).toBe(2 / 4)
    expect(score.onAnyEvent).toBe(3 / 4)
  })

  it('passes fewer looks at a higher threshold', () => {
    const score = scoreGate(looks, labels, { startedAt: START, threshold: 0.9 })

    expect(score.passesPerMinute).toBe(6)
    expect(score.recall).toBe(1 / 3)
  })
})
