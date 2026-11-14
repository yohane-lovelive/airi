import { describe, expect, it, vi } from 'vitest'

import { createProviderRelay, providerRelayBaseUrl } from '.'

/** The upstream server is the boundary. The fake records each request and gives a fixed reply. */
function setup(reply: () => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const upstream = vi.fn(async (_url: string, _init: RequestInit) => reply())
  const relay = createProviderRelay({ sessionId: 'session-1', fetch: upstream })
  return { relay, upstream }
}

function post(headers: Record<string, string> = {}) {
  return new Request('http://page.test/', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer key', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'gpt-6-luna' }),
  })
}

describe('createProviderRelay', () => {
  it('forwards a chat request to OpenCode Go with the session header and the key of the page', async () => {
    const { relay, upstream } = setup()

    const response = await relay('opencode-go', '/chat/completions', post())

    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledOnce()
    const [url, init] = upstream.mock.calls[0]
    expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions')
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('x-opencode-session')).toBe('session-1')
    expect(headers.get('authorization')).toBe('Bearer key')
    expect(headers.get('content-type')).toBe('application/json')
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"model":"gpt-6-luna"}')
  })

  it('keeps the cookies and the origin of the page away from the upstream server', async () => {
    const { relay, upstream } = setup()

    await relay('opencode-go', 'chat/completions', post({ Cookie: 'session=secret', Origin: 'http://page.test' }))

    const headers = new Headers(upstream.mock.calls[0][1].headers)
    expect(headers.has('cookie')).toBe(false)
    expect(headers.has('origin')).toBe(false)
  })

  it('keeps the query of a model list request', async () => {
    const { relay, upstream } = setup()

    await relay('opencode-go', '/models?limit=5', new Request('http://page.test/'))

    expect(upstream.mock.calls[0][0]).toBe('https://opencode.ai/zen/go/v1/models?limit=5')
    expect(upstream.mock.calls[0][1].body).toBeUndefined()
  })

  it('passes the reply through as a stream, with its status and its content type', async () => {
    const encoder = new TextEncoder()
    const { relay } = setup(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: one\n\n'))
        controller.enqueue(encoder.encode('data: two\n\n'))
        controller.close()
      },
    }), { status: 429, headers: { 'Content-Type': 'text/event-stream', 'Retry-After': '3', 'Set-Cookie': 'a=b' } }))

    const response = await relay('opencode-go', 'chat/completions', post())

    expect(response.status).toBe(429)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('retry-after')).toBe('3')
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.text()).toBe('data: one\n\ndata: two\n\n')
  })

  it('refuses a target that is not in its list', async () => {
    const { relay, upstream } = setup()

    const response = await relay('example.com', 'chat/completions', post())

    expect(response.status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })

  it.each([
    ['an absolute URL', 'https://example.com/v1/chat/completions'],
    ['a parent path', '../../other/chat/completions'],
  ])('refuses %s as the path', async (_name, path) => {
    const { relay, upstream } = setup()

    const response = await relay('opencode-go', path, post())

    expect(response.status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('refuses a method that a chat or a model list does not use', async () => {
    const { relay, upstream } = setup()

    const response = await relay('opencode-go', 'chat/completions', new Request('http://page.test/', { method: 'DELETE' }))

    expect(response.status).toBe(405)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('answers a preflight request without a call of the upstream server', async () => {
    const { relay, upstream } = setup()

    const response = await relay('opencode-go', 'chat/completions', new Request('http://page.test/', { method: 'OPTIONS' }))

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization')
    expect(upstream).not.toHaveBeenCalled()
  })

  it('answers 502 with the reason when the upstream server is out of reach', async () => {
    const { relay } = setup(() => {
      throw new Error('getaddrinfo ENOTFOUND opencode.ai')
    })

    const response = await relay('opencode-go', 'chat/completions', post())

    expect(response.status).toBe(502)
    const body = await response.json() as { error: { message: string } }
    expect(body.error.message).toContain('ENOTFOUND')
  })

  it('rejects when the page ended the request, so the host drops it', async () => {
    const controller = new AbortController()
    const upstream = vi.fn(async (_url: string, init: RequestInit) => {
      controller.abort()
      init.signal?.throwIfAborted()
      return new Response()
    })
    const relay = createProviderRelay({ sessionId: 'session-1', fetch: upstream })
    const request = new Request('http://page.test/', { signal: controller.signal })

    await expect(relay('opencode-go', 'models', request)).rejects.toThrow()
  })
})

describe('providerRelayBaseUrl', () => {
  it('gives the custom scheme for the desktop app and a path of the page origin for the web app', () => {
    expect(providerRelayBaseUrl('opencode-go', 'desktop')).toBe('airi-relay://opencode-go/')
    expect(providerRelayBaseUrl('opencode-go', { origin: 'http://localhost:5173' })).toBe('http://localhost:5173/provider-relay/opencode-go/')
  })
})
