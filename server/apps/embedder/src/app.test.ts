import type { TextEmbedder } from './model'

import { useLogger } from '@guiiai/logg'
import { describe, expect, it, vi } from 'vitest'

import { createEmbedderApp, MAX_BATCH_TEXTS } from './app'

function fakeEmbedder(): TextEmbedder {
  return { embed: vi.fn<TextEmbedder['embed']>(async texts => texts.map((_, index) => [index, 1])) }
}

function post(app: ReturnType<typeof createEmbedderApp>, body: unknown) {
  return app.request('/embed', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

describe('createEmbedderApp', () => {
  it('returns one embedding for each text, in order, for the task', async () => {
    const embedder = fakeEmbedder()
    const app = createEmbedderApp(embedder, useLogger('test'))

    const response = await post(app, { texts: ['a', 'b'], task: 'query' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ records: [{ embedding: [0, 1] }, { embedding: [1, 1] }] })
    expect(embedder.embed).toHaveBeenCalledWith(['a', 'b'], 'query')
  })

  it('refuses an unknown task, an empty text, and a batch over the limit', async () => {
    const embedder = fakeEmbedder()
    const app = createEmbedderApp(embedder, useLogger('test'))

    expect((await post(app, { texts: ['a'], task: 'image' })).status).toBe(400)
    expect((await post(app, { texts: [''], task: 'query' })).status).toBe(400)
    expect((await post(app, { texts: Array.from<string>({ length: MAX_BATCH_TEXTS + 1 }).fill('a'), task: 'query' })).status).toBe(400)
    expect((await post(app, 'not json')).status).toBe(400)
    expect(embedder.embed).not.toHaveBeenCalled()
  })

  it('answers the health check', async () => {
    const response = await createEmbedderApp(fakeEmbedder(), useLogger('test')).request('/healthz')

    expect(await response.json()).toEqual({ ok: true })
  })
})
