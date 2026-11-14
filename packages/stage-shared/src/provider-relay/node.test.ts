import type { AddressInfo } from 'node:net'

import { createServer } from 'node:http'

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import { createProviderRelay } from '.'
import { createNodeRelayHandler } from './node'

/** A real HTTP server with the handler, as the dev server of Vite mounts it. The upstream server is the fake. */
async function serve(upstream: (url: string, init: RequestInit) => Promise<Response>) {
  const server = createServer(createNodeRelayHandler(createProviderRelay({ sessionId: 'session-1', fetch: upstream })))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => {
    server.closeAllConnections()
    server.close()
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('createNodeRelayHandler', () => {
  it('forwards a chat request with its body and its key, and adds the session header', async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true }))
    const base = await serve(upstream)

    const response = await fetch(`${base}/opencode-go/chat/completions?stream=1`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6-luna' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    const [url, init] = upstream.mock.calls[0]
    expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions?stream=1')
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer key')
    expect(headers.get('x-opencode-session')).toBe('session-1')
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"model":"gpt-6-luna"}')
  })

  it('sends the reply chunk by chunk, before the upstream reply ends', async () => {
    const encoder = new TextEncoder()
    let finish = () => {}
    const base = await serve(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: one\n\n'))
        finish = () => {
          controller.enqueue(encoder.encode('data: two\n\n'))
          controller.close()
        }
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } }))

    const response = await fetch(`${base}/opencode-go/chat/completions`, { method: 'POST', body: '{}' })
    const reader = response.body!.getReader()
    const first = await reader.read()

    // The first chunk arrived while the upstream reply is still open.
    expect(new TextDecoder().decode(first.value)).toBe('data: one\n\n')
    finish()
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toBe('data: two\n\n')
    expect((await reader.read()).done).toBe(true)
  })

  it('ends the upstream request when the page ends its request', async () => {
    let upstreamSignal: AbortSignal | undefined
    const base = await serve(async (_url, init) => {
      upstreamSignal = init.signal ?? undefined
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: one\n\n'))
        },
      }))
    })
    const page = new AbortController()

    const response = await fetch(`${base}/opencode-go/chat/completions`, { method: 'POST', body: '{}', signal: page.signal })
    await response.body!.getReader().read()
    page.abort()

    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true))
  })

  it('gives the refusal of the relay for a target that is not in its list', async () => {
    const upstream = vi.fn(async () => Response.json({ ok: true }))
    const base = await serve(upstream)

    const response = await fetch(`${base}/example.com/chat/completions`)

    expect(response.status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })
})
