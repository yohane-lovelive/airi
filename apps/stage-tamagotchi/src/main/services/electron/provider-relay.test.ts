import { beforeEach, expect, it, vi } from 'vitest'

import { setupProviderRelayProtocol } from './provider-relay'

const { fetchUpstream, handleProtocol } = vi.hoisted(() => ({
  fetchUpstream: vi.fn(),
  handleProtocol: vi.fn(),
}))

vi.mock('electron', () => ({
  net: { fetch: fetchUpstream },
  protocol: { handle: handleProtocol },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

function handler() {
  setupProviderRelayProtocol()
  expect(handleProtocol.mock.calls[0][0]).toBe('airi-relay')
  return handleProtocol.mock.calls[0][1] as (request: Request) => Promise<Response>
}

it('forwards a request of the renderer to the target in its host name', async () => {
  fetchUpstream.mockResolvedValue(Response.json({ ok: true }))

  const response = await handler()(new Request('airi-relay://opencode-go/chat/completions?stream=1', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer key', 'Content-Type': 'application/json' },
    body: '{}',
  }))

  expect(response.status).toBe(200)
  expect(fetchUpstream).toHaveBeenCalledOnce()
  const [url, init] = fetchUpstream.mock.calls[0] as [string, RequestInit]
  expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions?stream=1')
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer key')
})

it('keeps one session id for a run of the app', async () => {
  fetchUpstream.mockImplementation(async () => Response.json({ ok: true }))
  const handle = handler()

  await handle(new Request('airi-relay://opencode-go/models'))
  await handle(new Request('airi-relay://opencode-go/models'))

  const sessions = fetchUpstream.mock.calls.map(([, init]) => new Headers((init as RequestInit).headers).get('x-opencode-session'))
  expect(sessions[0]).toMatch(/^[\da-f-]{36}$/)
  expect(sessions[1]).toBe(sessions[0])
})

it('refuses a host name that is not a relay target', async () => {
  const response = await handler()(new Request('airi-relay://example.com/chat/completions'))

  expect(response.status).toBe(404)
  expect(fetchUpstream).not.toHaveBeenCalled()
})
