import { randomUUID } from 'node:crypto'

import { createProviderRelay, PROVIDER_RELAY_SCHEME } from '@proj-airi/stage-shared/provider-relay'
import { net, protocol } from 'electron'

/**
 * Relays requests of the renderer to the model servers that a browser cannot call.
 *
 * Triggering workflow:
 *
 * A provider request in a renderer window
 *   -> `airi-relay://<target>/<path>` request
 *     -> `protocol.handle`
 *       -> `createProviderRelay` of `@proj-airi/stage-shared/provider-relay`
 *         -> `net.fetch` to the target
 *
 * Every window reaches the scheme, so the windows need no IPC for it. The session id lives for one run of the app.
 * `net.fetch` uses the network stack of Chromium, so the system proxy applies.
 *
 * Call it after the app is ready. The scheme must be in `protocol.registerSchemesAsPrivileged` before that.
 */
export function setupProviderRelayProtocol(): void {
  const relay = createProviderRelay({
    sessionId: randomUUID(),
    fetch: (url, init) => net.fetch(url, init),
  })

  protocol.handle(PROVIDER_RELAY_SCHEME, (request) => {
    const url = new URL(request.url)
    return relay(url.host, `${url.pathname}${url.search}`, request)
  })
}
