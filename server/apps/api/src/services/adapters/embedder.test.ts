import { ApiError } from '@proj-airi/http-error-shared'
import { describe, expect, it, vi } from 'vitest'

import { createEmbedderClient } from './embedder'

function clientWith(response: () => Promise<Response>) {
  const fetch = vi.fn<typeof globalThis.fetch>(response)
  return { fetch, client: createEmbedderClient({ url: 'http://embedder:3000', fetch }) }
}

describe('createEmbedderClient', () => {
  it('posts the texts and the task, and returns one vector for each text', async () => {
    const { fetch, client } = clientWith(async () => Response.json({ records: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }))

    expect(await client.embed(['a', 'b'], 'document')).toEqual([[1, 0], [0, 1]])
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe('http://embedder:3000/embed')
    expect(JSON.parse(String(init?.body))).toEqual({ texts: ['a', 'b'], task: 'document' })
  })

  it('throws 503 EMBEDDER_UNAVAILABLE for a failed request, an error status, and a wrong answer', async () => {
    const answers = [
      async () => { throw new TypeError('fetch failed') },
      async () => new Response('down', { status: 500 }),
      async () => Response.json({ records: [{ embedding: [1] }] }),
      async () => Response.json({ nope: true }),
    ]
    for (const answer of answers) {
      const error = await clientWith(answer).client.embed(['a', 'b'], 'query').catch(caught => caught)
      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({ statusCode: 503, errorCode: 'EMBEDDER_UNAVAILABLE' })
    }
  })
})
