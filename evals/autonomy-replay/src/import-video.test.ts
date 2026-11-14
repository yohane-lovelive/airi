import type { FrameExtractor } from './import-video'

import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { Transformer } from '@napi-rs/image'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { importVideo, recordingIdFrom } from './import-video'
import { frameImage, loadRecording } from './recording'

const START = Date.UTC(2026, 10, 12, 13, 0, 0)

/** One JPEG of a single color, 320 by 180 pixels. */
async function plainJpeg(red: number, green: number, blue: number) {
  const pixels = new Uint8Array(320 * 180 * 4)
  for (let index = 0; index < pixels.length; index += 4)
    pixels.set([red, green, blue, 255], index)
  return Transformer.fromRgbaPixels(pixels, 320, 180).jpeg(90)
}

/** ffmpeg is the boundary. The fake writes the frames that ffmpeg would write: two white ones, then a black one. */
const threeFrames: FrameExtractor = async ({ directory }) => {
  await writeFile(join(directory, '000001.jpg'), await plainJpeg(255, 255, 255))
  await writeFile(join(directory, '000002.jpg'), await plainJpeg(255, 255, 255))
  await writeFile(join(directory, '000003.jpg'), await plainJpeg(0, 0, 0))
}

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  }
  catch {
    return false
  }
}

describe('recordingIdFrom', () => {
  it('makes a folder name from the file name of the video', () => {
    expect(recordingIdFrom('D:/Videos/League of Legends_11-12-2026_22-29-55-0.mp4')).toBe('League-of-Legends_11-12-2026_22-29-55-0')
  })
})

describe('importVideo', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'airi-import-'))
    await writeFile(join(root, 'play.mp4'), 'not read by the fake')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes a recording that the replay reads, with one frame each half second', async () => {
    const result = await importVideo({ video: join(root, 'play.mp4'), recordings: join(root, 'recordings'), startedAt: START, app: 'Game', extractFrames: threeFrames })

    const recording = loadRecording(result.directory)

    expect(result.frames).toBe(3)
    expect(recording.id).toBe('play')
    expect(recording.frames.map(frame => frame.at)).toEqual([START, START + 500, START + 1000])
    expect(recording.frames.map(frame => frame.app)).toEqual(['Game', 'Game', 'Game'])
    expect(recording.endedAt).toBe(START + 1000)
    expect(recording.ownerMessages).toEqual([])
    expect(await frameImage(recording, recording.frames[2])).toBe((await plainJpeg(0, 0, 0)).toString('base64'))
  })

  it('gives each frame the grayscale thumbnail that the detectors compare', async () => {
    const result = await importVideo({ video: join(root, 'play.mp4'), recordings: join(root, 'recordings'), startedAt: START, extractFrames: threeFrames })

    const [white, , black] = loadRecording(result.directory).frames

    expect(white.thumbnail).toHaveLength(64 * 36)
    expect(Math.min(...white.thumbnail)).toBeGreaterThan(250)
    expect(Math.max(...black.thumbnail)).toBeLessThan(5)
  })

  it('records the size of the frames in the manifest, as the recorder of the app does', async () => {
    const result = await importVideo({ video: join(root, 'play.mp4'), recordings: join(root, 'recordings'), startedAt: START, extractFrames: threeFrames })

    const manifest = JSON.parse(await readFile(join(result.directory, 'manifest.json'), 'utf8'))

    expect(manifest.frames).toBe(3)
    expect(manifest.bytes).toBe((await plainJpeg(255, 255, 255)).length * 2 + (await plainJpeg(0, 0, 0)).length)
  })

  it('ends the recording at the last change of the video file when no start time is given', async () => {
    const changedAt = new Date(START + 60_000)
    await utimes(join(root, 'play.mp4'), changedAt, changedAt)

    const result = await importVideo({ video: join(root, 'play.mp4'), recordings: join(root, 'recordings'), extractFrames: threeFrames })

    expect(loadRecording(result.directory).endedAt).toBe(START + 60_000)
    expect(loadRecording(result.directory).startedAt).toBe(START + 59_000)
  })

  it('rejects when the recording exists already, and leaves its files', async () => {
    const options = { video: join(root, 'play.mp4'), recordings: join(root, 'recordings'), startedAt: START, extractFrames: threeFrames }
    const first = await importVideo(options)
    const before = await stat(join(first.directory, 'manifest.json'))

    await expect(importVideo(options)).rejects.toThrow('EEXIST')

    expect((await stat(join(first.directory, 'manifest.json'))).mtimeMs).toBe(before.mtimeMs)
  })

  it('rejects a video without frames', async () => {
    await expect(importVideo({ video: join(root, 'play.mp4'), recordings: join(root, 'recordings'), extractFrames: async () => {} })).rejects.toThrow('gave no frames')
  })
})

/** Runs the real ffmpeg on a test pattern. A system without ffmpeg skips it. */
describe.skipIf(!hasFfmpeg())('importVideo with ffmpeg', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'airi-import-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('takes 2 frames each second and scales a large video down to 1280 pixels', async () => {
    const video = join(root, 'pattern.mp4')
    await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=1920x1080:rate=30', '-pix_fmt', 'yuv420p', video])

    const result = await importVideo({ video, recordings: join(root, 'recordings'), startedAt: START })

    const recording = loadRecording(result.directory)
    const metadata = await new Transformer(await readFile(join(result.directory, recording.frames[0].file))).metadata()
    expect(recording.frames).toHaveLength(4)
    expect(metadata.width).toBe(1280)
    expect(metadata.height).toBe(720)
  }, 60_000)
})
