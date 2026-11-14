import { errorMessageFrom } from '@moeru/std'

// NOTICE:
// Node loads this file from the Vite configs without a bundler, and Node does not resolve extensionless relative
// imports. So this file imports nothing relative.
// Source: the same constraint as `../analytics/sentry-vite.ts`.
// Removal condition: when the Vite configs load through a bundler that resolves extensionless imports.

/** The custom scheme of the desktop relay. A request is `airi-relay://<target>/<path>`. */
export const PROVIDER_RELAY_SCHEME = 'airi-relay'

/** The path of the relay on a web server. A request is `/provider-relay/<target>/<path>`. */
export const PROVIDER_RELAY_PATH = '/provider-relay'

/**
 * The upstream servers that the relay reaches, by target name.
 *
 * The list is closed. A request for another name gets 404, so the relay is not an open proxy.
 */
const targets = {
  'opencode-go': {
    baseUrl: 'https://opencode.ai/zen/go/v1/',
    /** The server answers HTTP 400 `MissingSessionID` without this header. Any UUID is valid. */
    sessionHeader: 'x-opencode-session',
  },
} as const

/** The name of an upstream server that the relay reaches. */
export type ProviderRelayTarget = keyof typeof targets

/** The page sends only these headers to the upstream server. Its cookies and its origin stay behind. */
const forwardedRequestHeaders = ['authorization', 'content-type', 'accept']

/** `retry-after` lets the caller wait for the time that the upstream server asks for. */
const forwardedResponseHeaders = ['content-type', 'cache-control', 'retry-after']

/** The desktop page has another origin than the relay scheme, so each reply allows every origin. */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': forwardedRequestHeaders.join(', '),
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

function refusal(status: number, message: string) {
  // The shape is the error body of an OpenAI-compatible server, so the chat shows the message.
  return Response.json({ error: { message, type: 'provider_relay_error' } }, { status, headers: corsHeaders })
}

function isRelayTarget(name: string): name is ProviderRelayTarget {
  return Object.hasOwn(targets, name)
}

/**
 * Creates the relay between a page and a model server that a browser cannot call.
 *
 * A browser cannot call OpenCode Go: the server answers no CORS preflight, and it needs a header that a page cannot
 * send across origins. The host of the page runs this relay: Electron main for the desktop app, and the Vite server
 * for the web app.
 *
 * The relay keeps no API key. The page sends its own `Authorization` header, and the relay forwards it.
 *
 * @param options The values of the host.
 * @param options.sessionId The session id that the upstream server needs. One id for each start of the host.
 * @param options.fetch The request function of the host. Electron main gives `net.fetch`, so the system proxy applies.
 * @default options.fetch `globalThis.fetch`
 */
export function createProviderRelay(options: {
  sessionId: string
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}) {
  const send = options.fetch ?? ((url, init) => globalThis.fetch(url, init))

  /**
   * Forwards one request.
   *
   * @param target The target name from the request URL.
   * @param path The path and the query after the target name.
   * @param request The request of the page. Its abort signal also ends the upstream request.
   */
  return async function relay(target: string, path: string, request: Request): Promise<Response> {
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders })
    if (!isRelayTarget(target))
      return refusal(404, `The relay has no target "${target}".`)
    if (request.method !== 'GET' && request.method !== 'POST')
      return refusal(405, `The relay does not forward ${request.method} requests.`)

    const upstream = targets[target]
    const url = new URL(path.replace(/^\/+/, ''), upstream.baseUrl)
    // An absolute URL or `..` in the path can point outside the API of the target.
    if (!url.href.startsWith(upstream.baseUrl))
      return refusal(400, 'The path is outside the target.')

    const headers = new Headers({ [upstream.sessionHeader]: options.sessionId })
    for (const name of forwardedRequestHeaders) {
      const value = request.headers.get(name)
      if (value !== null)
        headers.set(name, value)
    }

    let response: Response
    try {
      response = await send(url.href, {
        method: request.method,
        headers,
        // The body is read whole. A chat request with images is a few megabytes at most.
        body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
        signal: request.signal,
      })
    }
    catch (error) {
      // The page ended the request, so no reply is read. The rejection tells the host to drop it.
      if (request.signal.aborted)
        throw error
      return refusal(502, `The relay could not reach ${url.host}: ${errorMessageFrom(error) ?? 'unknown error'}`)
    }

    const replyHeaders = new Headers(corsHeaders)
    for (const name of forwardedResponseHeaders) {
      const value = response.headers.get(name)
      if (value !== null)
        replyHeaders.set(name, value)
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: replyHeaders })
  }
}

/**
 * The base URL of a relay target, as the page of each host reaches it.
 *
 * @param target The target name.
 * @param host `desktop` for the custom scheme of Electron. A web page gives its own origin.
 *
 * @example
 * providerRelayBaseUrl('opencode-go', 'desktop')
 * // => 'airi-relay://opencode-go/'
 * providerRelayBaseUrl('opencode-go', { origin: 'http://localhost:5173' })
 * // => 'http://localhost:5173/provider-relay/opencode-go/'
 */
export function providerRelayBaseUrl(target: ProviderRelayTarget, host: 'desktop' | { origin: string }) {
  if (host === 'desktop')
    return `${PROVIDER_RELAY_SCHEME}://${target}/`
  return `${host.origin}${PROVIDER_RELAY_PATH}/${target}/`
}
