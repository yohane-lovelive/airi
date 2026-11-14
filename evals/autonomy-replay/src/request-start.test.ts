import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadRecording } from './recording'
import { requestStartOf } from './request-start'

const tool = { type: 'function', function: { name: 'memory_search', description: 'Searches memories.', parameters: { type: 'object', properties: {} } } }

describe('requestStartOf', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'airi-request-start-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** Writes an empty recording, with the request start that the app wrote when one is given. */
  async function writeRecording(requestStart?: unknown) {
    const directory = join(root, 'recording')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ id: 'recording', startedAt: 0, frames: 0 }))
    if (requestStart)
      await writeFile(join(directory, 'request-start.json'), JSON.stringify(requestStart))
    return loadRecording(directory)
  }

  it('reads the request start that the app wrote into the recording', async () => {
    const recording = await writeRecording({ model: 'gpt-6-luna', purpose: 'commentary', systemPrompt: 'You are AIRI.', tools: [tool] })

    expect(requestStartOf(recording)).toEqual({ systemPrompt: 'You are AIRI.', tools: [tool] })
  })

  it('takes the file that the run names over the file of the recording', async () => {
    const recording = await writeRecording({ systemPrompt: 'The recorded character.', tools: [] })
    const override = join(root, 'other.json')
    await writeFile(override, JSON.stringify({ systemPrompt: 'Another character.', tools: [tool] }))

    expect(requestStartOf(recording, override)?.systemPrompt).toBe('Another character.')
  })

  it('gives nothing for a recording without a request start, for example an imported video', async () => {
    expect(requestStartOf(await writeRecording())).toBeUndefined()
  })

  it('rejects a file of another form', async () => {
    const recording = await writeRecording({ systemPrompt: 'You are AIRI.', tools: [{ name: 'memory_search' }] })

    expect(() => requestStartOf(recording)).toThrow()
  })
})
