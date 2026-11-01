import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PERCEPTION_RECORDER_LIMITS, PerceptionRecorderService } from '.'

const START = Date.UTC(2026, 10, 2, 10, 0, 0)

function frame(at: number, bytes = 4) {
  return { at, image: new Uint8Array(bytes).fill(7), thumbnail: 'AAAA', app: 'Game' }
}

describe('perceptionRecorderService', () => {
  let directory: string
  let now: number

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'airi-recorder-'))
    now = START
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  function recorder() {
    return new PerceptionRecorderService({ directory, appVersion: '1.0.0', now: () => now })
  }

  it('writes frames, their lines, events, and a manifest into one folder', async () => {
    const service = recorder()
    const started = await service.start()
    await service.appendFrame(started.id, frame(START + 500))
    await service.appendEvents(started.id, [{ kind: 'screen', at: START + 600, type: 'scene-change', salience: 0.5 }, { kind: 'owner-message', at: START + 700 }])
    now = START + 1_000
    const stopped = await service.stop()

    const folder = join(directory, started.id)
    expect(started.id).toBe('2026-11-02T10-00-00')
    expect(await readdir(join(folder, 'frames'))).toEqual(['000001.jpg'])
    expect(JSON.parse((await readFile(join(folder, 'frames.jsonl'), 'utf8')).trim())).toEqual({ at: START + 500, file: 'frames/000001.jpg', app: 'Game', thumbnail: 'AAAA' })
    expect((await readFile(join(folder, 'events.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2)
    expect(JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'))).toMatchObject({ id: started.id, startedAt: START, endedAt: START + 1_000, frames: 1, appVersion: '1.0.0', stoppedBy: 'owner' })
    expect(stopped).toMatchObject({ frames: 1, recording: false })
  })

  it('lists recordings newest first, with the running one marked', async () => {
    const service = recorder()
    const first = await service.start()
    await service.stop()
    now = START + 60_000
    const second = await service.start()
    await service.appendFrame(second.id, frame(now))

    const list = await service.list()
    expect(list.map(recording => recording.id)).toEqual([second.id, first.id])
    expect(list[0]).toMatchObject({ recording: true, frames: 1 })
    expect(list[1]).toMatchObject({ recording: false, frames: 0 })
  })

  it('stops by itself at its time limit, and ignores frames of another recording', async () => {
    const service = recorder()
    const started = await service.start()

    expect(await service.appendFrame('other', frame(START))).toEqual({ stopped: 'not-recording' })
    expect(await service.appendFrame(started.id, frame(START + PERCEPTION_RECORDER_LIMITS.maxDurationMs))).toEqual({ stopped: 'time' })
    expect(await service.appendFrame(started.id, frame(START + PERCEPTION_RECORDER_LIMITS.maxDurationMs + 500))).toEqual({ stopped: 'not-recording' })
    expect(JSON.parse(await readFile(join(directory, started.id, 'manifest.json'), 'utf8'))).toMatchObject({ stoppedBy: 'time' })
  })

  it('deletes one recording and refuses any path outside the folder', async () => {
    const service = recorder()
    const started = await service.start()
    await service.stop()

    expect(await service.remove('..')).toBe(false)
    expect(await service.remove('../outside')).toBe(false)
    expect(await service.remove('')).toBe(false)
    expect(await service.remove(started.id)).toBe(true)
    await expect(stat(join(directory, started.id))).rejects.toThrow()
    expect(await service.list()).toEqual([])
  })
})
