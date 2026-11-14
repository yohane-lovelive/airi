import type { PerceptionRecordedEvent, PerceptionRecordedFrame, PerceptionRecordingInfo } from '../../../../shared/eventa'

import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

/** Limits of one recording. A recording stops by itself at the first one. */
export const PERCEPTION_RECORDER_LIMITS = {
  maxDurationMs: 20 * 60_000,
  maxBytes: 1024 ** 3,
} as const

interface ActiveRecording {
  id: string
  directory: string
  startedAt: number
  frames: number
  bytes: number
}

/** The manifest of one recording folder. Replay evaluation reads it first. */
interface RecordingManifest {
  id: string
  startedAt: number
  endedAt?: number
  frames: number
  bytes: number
  appVersion?: string
  stoppedBy?: 'owner' | 'time' | 'size'
}

/** A folder name from a time, for example `2026-11-02T10-15-30`. It sorts by time and is valid on every file system. */
function folderName(at: number) {
  return new Date(at).toISOString().slice(0, 19).replace(/:/g, '-')
}

/**
 * Writes screen recordings for replay evaluation. It is the only part of the app that keeps frames on the disk.
 *
 * - Each recording is one folder under `directory`: `frames/<n>.jpg`, `frames.jsonl` with one line for each frame,
 *   `events.jsonl` with the screen events and the owner messages, and `manifest.json`.
 * - One recording runs at a time. It stops by itself at its time or size limit.
 * - Delete and list touch only the folders under `directory`.
 *
 * Use when:
 * - The perception runner of the leader records while the owner asked for it, in the desktop app only.
 */
export class PerceptionRecorderService {
  private active: ActiveRecording | undefined

  constructor(private readonly options: { directory: string, appVersion?: string, now?: () => number }) {}

  private now() {
    return this.options.now?.() ?? Date.now()
  }

  /** The folder of the recordings, for the "open folder" button. */
  get directory() {
    return this.options.directory
  }

  /** Starts a recording. A running recording stops first. */
  async start(): Promise<PerceptionRecordingInfo> {
    if (this.active)
      await this.stop('owner')
    const startedAt = this.now()
    let id = folderName(startedAt)
    // Two starts in one second get two folders.
    for (let suffix = 2; await this.exists(id); suffix++)
      id = `${folderName(startedAt)}-${suffix}`
    const directory = join(this.options.directory, id)
    await mkdir(join(directory, 'frames'), { recursive: true })
    this.active = { id, directory, startedAt, frames: 0, bytes: 0 }
    await this.writeManifest({ id, startedAt, frames: 0, bytes: 0, ...(this.options.appVersion ? { appVersion: this.options.appVersion } : {}) })
    return { id, startedAt, frames: 0, bytes: 0, recording: true }
  }

  /** Adds one frame. Resolves to the reason when the recording stopped at a limit, or when no recording runs. */
  async appendFrame(id: string, frame: PerceptionRecordedFrame): Promise<{ stopped?: 'time' | 'size' | 'not-recording' }> {
    const active = this.active
    if (!active || active.id !== id)
      return { stopped: 'not-recording' }
    active.frames += 1
    const file = `frames/${String(active.frames).padStart(6, '0')}.jpg`
    await writeFile(join(active.directory, file), frame.image)
    const line = `${JSON.stringify({ at: frame.at, file, ...(frame.app ? { app: frame.app } : {}), thumbnail: frame.thumbnail })}\n`
    await appendFile(join(active.directory, 'frames.jsonl'), line)
    active.bytes += frame.image.byteLength + line.length
    if (frame.at - active.startedAt >= PERCEPTION_RECORDER_LIMITS.maxDurationMs) {
      await this.stop('time')
      return { stopped: 'time' }
    }
    if (active.bytes >= PERCEPTION_RECORDER_LIMITS.maxBytes) {
      await this.stop('size')
      return { stopped: 'size' }
    }
    return {}
  }

  /** Adds screen events and owner marks. */
  async appendEvents(id: string, events: readonly PerceptionRecordedEvent[]) {
    const active = this.active
    if (!active || active.id !== id || !events.length)
      return
    const lines = events.map(event => `${JSON.stringify(event)}\n`).join('')
    await appendFile(join(active.directory, 'events.jsonl'), lines)
    active.bytes += lines.length
  }

  /** Stops the running recording and writes its manifest. Resolves to its info, or `undefined` without one. */
  async stop(stoppedBy: 'owner' | 'time' | 'size' = 'owner'): Promise<PerceptionRecordingInfo | undefined> {
    const active = this.active
    if (!active)
      return undefined
    this.active = undefined
    const endedAt = this.now()
    await this.writeManifest({ id: active.id, startedAt: active.startedAt, endedAt, frames: active.frames, bytes: active.bytes, stoppedBy, ...(this.options.appVersion ? { appVersion: this.options.appVersion } : {}) }, active.directory)
    return { id: active.id, startedAt: active.startedAt, endedAt, frames: active.frames, bytes: active.bytes, recording: false }
  }

  /** The recordings on the device, newest first. */
  async list(): Promise<PerceptionRecordingInfo[]> {
    const entries = await readdir(this.options.directory, { withFileTypes: true }).catch(() => [])
    const recordings = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async (entry) => {
      try {
        const manifest = JSON.parse(await readFile(join(this.options.directory, entry.name, 'manifest.json'), 'utf8')) as RecordingManifest
        const recording = this.active?.id === entry.name
        return {
          id: entry.name,
          startedAt: manifest.startedAt,
          ...(manifest.endedAt !== undefined ? { endedAt: manifest.endedAt } : {}),
          frames: recording ? this.active!.frames : manifest.frames,
          bytes: recording ? this.active!.bytes : manifest.bytes,
          recording,
        }
      }
      catch {
        // A folder without a manifest is not a recording of this app.
        return undefined
      }
    }))
    return recordings.filter(recording => recording !== undefined).sort((left, right) => right.startedAt - left.startedAt)
  }

  /** Deletes one recording. It refuses any path outside the recordings folder. */
  async remove(id: string): Promise<boolean> {
    const target = resolve(this.options.directory, id)
    const inside = relative(resolve(this.options.directory), target)
    if (!id || !inside || inside.startsWith('..') || inside.includes('/') || inside.includes('\\'))
      return false
    if (this.active?.id === id)
      await this.stop('owner')
    if (!await this.exists(id))
      return false
    await rm(target, { recursive: true, force: true })
    return true
  }

  private async exists(id: string) {
    return stat(join(this.options.directory, id)).then(() => true, () => false)
  }

  private async writeManifest(manifest: RecordingManifest, directory = this.active?.directory) {
    if (directory)
      await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
}
