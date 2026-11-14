import type { IncomingMessage, ServerResponse } from 'node:http'

import { errorMessageFrom } from '@moeru/std'

// NOTICE:
// Node loads this file from the Vite configs without a bundler, and it resolves no extensionless relative import.
// So this file imports nothing relative, and the caller passes the relay in.
// Source: the same constraint as `../analytics/sentry-vite.ts`.
// Removal condition: when the Vite configs load through a bundler.

/** The relay that `createProviderRelay` of `@proj-airi/stage-shared/provider-relay` returns. */
type Relay = (target: string, path: string, request: Request) => Promise<Response>

/** A request without a body. `Request` refuses a body for these methods. */
const bodilessMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Adapts the provider relay to a Node HTTP server, for example the dev server of Vite.
 *
 * The server mounts the handler at the relay path. So the URL of each request starts after that path, with the target
 * name: `/<target>/<path>`.
 *
 * The reply goes out chunk by chunk, so the page reads a chat reply as a stream. When the page ends the request, the
 * upstream request ends too.
 */
export function createNodeRelayHandler(relay: Relay) {
  return async function handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    const url = new URL(incoming.url ?? '/', 'http://relay.invalid')
    const [target = '', ...rest] = url.pathname.split('/').filter(part => part.length > 0)

    const pageLeft = new AbortController()
    outgoing.on('close', () => {
      // `close` also follows a complete reply. Only an early close means that the page left.
      if (!outgoing.writableEnded)
        pageLeft.abort()
    })

    try {
      const chunks: Uint8Array[] = []
      for await (const chunk of incoming)
        chunks.push(chunk)
      const body = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }

      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string')
          headers.set(name, value)
      }
      const method = incoming.method ?? 'GET'
      const response = await relay(target, `${rest.join('/')}${url.search}`, new Request(url, {
        method,
        headers,
        body: bodilessMethods.has(method) ? undefined : body,
        signal: pageLeft.signal,
      }))

      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) {
        const reader = response.body.getReader()
        // A reply that is still open has no reader after the page left, so the read below ends.
        pageLeft.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true })
        for (;;) {
          const { done, value } = await reader.read()
          if (done)
            break
          outgoing.write(value)
        }
      }
      outgoing.end()
    }
    catch (error) {
      // Nobody reads a reply after the page left.
      if (pageLeft.signal.aborted) {
        outgoing.destroy()
        return
      }
      if (!outgoing.headersSent)
        outgoing.writeHead(502, { 'Content-Type': 'application/json' })
      outgoing.end(JSON.stringify({ error: { message: `The relay failed: ${errorMessageFrom(error) ?? 'unknown error'}`, type: 'provider_relay_error' } }))
    }
  }
}
