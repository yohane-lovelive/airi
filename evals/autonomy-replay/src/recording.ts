import type { Dirent } from 'node:fs'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

import { literal, number, object, optional, parse, string, union } from 'valibot'

/** One frame of a recording. The JPEG stays on the disk until a turn sends it. */
export interface RecordedFrame {
  readonly at: number
  readonly file: string
  readonly app?: string
  /** The 64 by 36 grayscale thumbnail, one byte for each pixel. */
  readonly thumbnail: Uint8Array
}

/** One owner message of a recording. The text was never recorded. */
export interface RecordedOwnerMessage {
  readonly at: number
}

/** A recording that the screen recorder of the desktop app wrote. */
export interface Recording {
  readonly id: string
  readonly directory: string
  readonly startedAt: number
  readonly endedAt: number
  readonly frames: readonly RecordedFrame[]
  readonly ownerMessages: readonly RecordedOwnerMessage[]
}

const manifestSchema = object({ id: string(), startedAt: number(), endedAt: optional(number()), frames: number() })
const frameSchema = object({ at: number(), file: string(), app: optional(string()), thumbnail: string() })
const eventSchema = union([
  object({ kind: literal('screen'), at: number(), type: string(), salience: number(), app: optional(string()) }),
  object({ kind: literal('owner-message'), at: number() }),
])

function lines(text: string) {
  return text.split('\n').map(line => line.trim()).filter(Boolean)
}

/** The recordings folder of the desktop app on this system. */
export function defaultRecordingsDirectory() {
  const home = homedir()
  const data = platform() === 'win32'
    ? process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    : platform() === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME ?? join(home, '.config')
  return join(data, '@proj-airi', 'stage-tamagotchi', 'perception-recordings')
}

/** Reads a text file, or an empty text when it does not exist. */
function readText(path: string) {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return ''
  }
}

/**
 * Reads one recording folder. The frame images stay on the disk, and `frameImage` reads one when a turn sends it.
 * It reads synchronously, because vieval needs the cases when the task file loads.
 */
export function loadRecording(directory: string): Recording {
  const manifest = parse(manifestSchema, JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')))
  const frames = lines(readText(join(directory, 'frames.jsonl'))).map((line) => {
    const frame = parse(frameSchema, JSON.parse(line))
    return { at: frame.at, file: frame.file, ...(frame.app ? { app: frame.app } : {}), thumbnail: new Uint8Array(Buffer.from(frame.thumbnail, 'base64')) }
  })
  const events = lines(readText(join(directory, 'events.jsonl'))).map(line => parse(eventSchema, JSON.parse(line)))
  return {
    id: manifest.id,
    directory,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt ?? frames.at(-1)?.at ?? manifest.startedAt,
    frames: frames.sort((left, right) => left.at - right.at),
    ownerMessages: events.filter(event => event.kind === 'owner-message').map(event => ({ at: event.at })),
  }
}

/** Reads every recording under a folder, oldest first. A folder without a valid manifest is skipped. */
export function loadRecordings(root: string): Recording[] {
  let entries: Dirent[] = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  }
  catch {
    return []
  }
  return entries.filter(entry => entry.isDirectory()).flatMap((entry) => {
    try {
      return [loadRecording(join(root, entry.name))]
    }
    catch {
      return []
    }
  }).sort((left, right) => left.startedAt - right.startedAt)
}

/** The JPEG of one frame as base64. */
export async function frameImage(recording: Recording, frame: RecordedFrame): Promise<string> {
  return (await readFile(join(recording.directory, frame.file))).toString('base64')
}
