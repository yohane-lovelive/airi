import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'

import { ResizeFit, Transformer } from '@napi-rs/image'

/**
 * The frame form of the screen recorder of the app (`FRAME_LIMITS` in `packages/stage-ui/src/libs/perception/frame-ring.ts`).
 * An imported video must have the same form, so the detectors and the frame policies see what they see in the app.
 */
const FRAME_FORM = {
  /** The app takes 2 frames each second. */
  intervalMs: 500,
  /** The app scales a frame down to this many pixels on its long side, and never up. */
  maxLongSide: 1280,
  thumbnailWidth: 64,
  thumbnailHeight: 36,
} as const

/** Writes the frames of a video as JPEG files `<directory>/%06d.jpg`, counted from 1. */
export type FrameExtractor = (input: { video: string, directory: string, framesPerSecond: number, maxLongSide: number }) => Promise<void>

/** What {@link importVideo} reads. */
export interface VideoImportOptions {
  /** The video file, in a format that ffmpeg reads. */
  readonly video: string
  /** The recordings folder. The recording gets its own folder in it. */
  readonly recordings: string
  /**
   * The name of the recording and of its folder.
   *
   * @default the file name of the video, in the form of {@link recordingIdFrom}
   */
  readonly id?: string
  /**
   * The time of the first frame as epoch milliseconds. The notice of a turn tells the model the time of the day.
   *
   * @default the time of the last change of the video file, minus the length of the recording
   */
  readonly startedAt?: number
  /** The app in front for every frame, as the app reports it. Without it, the frames name no app. */
  readonly app?: string
  /**
   * Takes the frames out of the video.
   *
   * @default ffmpeg from the PATH
   */
  readonly extractFrames?: FrameExtractor
}

/**
 * Normalizes a video file name to a recording name that is a valid folder name on every file system.
 *
 * @example
 * recordingIdFrom('D:/Videos/League of Legends_11-12-2026_22-29-55-0.mp4')
 * // => 'League-of-Legends_11-12-2026_22-29-55-0'
 */
export function recordingIdFrom(video: string) {
  return basename(video, extname(video)).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'video'
}

const run = promisify(execFile)

/**
 * Takes the frames out with ffmpeg. The arguments go as a list, so no shell reads the file name.
 * `min(...)` keeps a small video at its size, as the app does.
 */
const extractWithFfmpeg: FrameExtractor = async ({ video, directory, framesPerSecond, maxLongSide }) => {
  const scale = `scale='if(gte(iw,ih),min(${maxLongSide},iw),-2)':'if(gte(iw,ih),-2,min(${maxLongSide},ih))'`
  try {
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-i',
      video,
      '-vf',
      `fps=${framesPerSecond},${scale}`,
      // The JPEG scale of ffmpeg goes from 2 (best) to 31. 5 is near the quality 0.75 of the app.
      '-q:v',
      '5',
      join(directory, '%06d.jpg'),
    ], { maxBuffer: 16 * 1024 * 1024 })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('ffmpeg is not on the PATH. Install it to import a video.', { cause: error })
    throw error
  }
}

/**
 * The grayscale thumbnail of one frame, one byte for each pixel, as base64. The app makes the same one in
 * `encodeFrame`: the whole frame at the thumbnail size, with the Rec. 601 weights.
 */
async function thumbnailOf(jpeg: Uint8Array) {
  const { thumbnailWidth, thumbnailHeight } = FRAME_FORM
  const pixels = await new Transformer(Buffer.from(jpeg)).resize(thumbnailWidth, thumbnailHeight, null, ResizeFit.Fill).rawPixels()
  // The decoder gives 3 bytes for each pixel, or 4 with alpha, or 1 for a gray image.
  const channels = pixels.length / (thumbnailWidth * thumbnailHeight)
  const thumbnail = new Uint8Array(thumbnailWidth * thumbnailHeight)
  for (let index = 0; index < thumbnail.length; index++) {
    const offset = index * channels
    thumbnail[index] = channels >= 3
      ? Math.round(0.299 * pixels[offset] + 0.587 * pixels[offset + 1] + 0.114 * pixels[offset + 2])
      : pixels[offset]
  }
  return Buffer.from(thumbnail).toString('base64')
}

/**
 * Turns a video of a screen into a recording in the format of the screen recorder of the desktop app, so the replay
 * can read a play video that the app did not record.
 *
 * - The recording has 2 frames each second, at most 1280 pixels on the long side, like a recording of the app.
 * - It holds no owner messages, and the replay finds the screen events again from the thumbnails.
 * - A folder that exists already is an error, so an import never mixes two videos.
 *
 * Resolves to the folder of the recording and its frame count.
 */
export async function importVideo(options: VideoImportOptions): Promise<{ directory: string, id: string, frames: number }> {
  const id = options.id ?? recordingIdFrom(options.video)
  const directory = join(options.recordings, id)
  const framesDirectory = join(directory, 'frames')
  // Without `recursive`, an existing folder rejects.
  await mkdir(options.recordings, { recursive: true })
  await mkdir(directory)
  await mkdir(framesDirectory)

  await (options.extractFrames ?? extractWithFfmpeg)({
    video: options.video,
    directory: framesDirectory,
    framesPerSecond: 1000 / FRAME_FORM.intervalMs,
    maxLongSide: FRAME_FORM.maxLongSide,
  })

  const files = (await readdir(framesDirectory)).filter(file => file.endsWith('.jpg')).sort()
  if (!files.length)
    throw new Error(`The video gave no frames: ${options.video}`)
  const durationMs = (files.length - 1) * FRAME_FORM.intervalMs
  const startedAt = options.startedAt ?? Math.round((await stat(options.video)).mtimeMs) - durationMs

  const lines: string[] = []
  let bytes = 0
  for (const [index, file] of files.entries()) {
    const jpeg = await readFile(join(framesDirectory, file))
    bytes += jpeg.length
    lines.push(JSON.stringify({
      at: startedAt + index * FRAME_FORM.intervalMs,
      file: `frames/${file}`,
      ...(options.app ? { app: options.app } : {}),
      thumbnail: await thumbnailOf(jpeg),
    }))
  }
  await writeFile(join(directory, 'frames.jsonl'), `${lines.join('\n')}\n`)
  await writeFile(join(directory, 'events.jsonl'), '')
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({ id, startedAt, endedAt: startedAt + durationMs, frames: files.length, bytes }, null, 2)}\n`)
  return { directory, id, frames: files.length }
}
