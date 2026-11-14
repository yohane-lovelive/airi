import { authedFetch } from '../libs/auth-fetch'
import { SERVER_URL } from '../libs/server'

const HOSTED_CLOUD_URL = 'https://cloud.airi.build'

/**
 * The Cloud origin of the signed-in account, or `undefined` when the server has no Cloud.
 *
 * The hosted Cloud accepts only tokens of the hosted server. A token of a self-hosted server gets 401 there, and
 * `authedFetch` then ends the session. So a server outside `airi.build` has no Cloud unless `VITE_CLOUD_URL` names one.
 *
 * @example
 * resolveCloudUrl('https://api.airi.build') // => 'https://cloud.airi.build'
 * resolveCloudUrl('http://localhost:6112') // => undefined
 */
export function resolveCloudUrl(serverUrl = SERVER_URL): string | undefined {
  if (import.meta.env.VITE_CLOUD_URL)
    return import.meta.env.VITE_CLOUD_URL
  const hostname = new URL(serverUrl).hostname
  return hostname === 'airi.build' || hostname.endsWith('.airi.build') ? HOSTED_CLOUD_URL : undefined
}

/** Uses the Cloud origin and shared token refresh. Only same-origin paths can receive credentials. */
export function useCloudFetch() {
  const cloudUrl = resolveCloudUrl()

  return (path: string, init?: RequestInit): Promise<Response> => {
    if (!cloudUrl)
      throw new Error('This server has no Cloud')
    const baseUrl = new URL(cloudUrl)
    const url = new URL(path, baseUrl)
    if (url.origin !== baseUrl.origin || url.username || url.password)
      throw new Error('Cloud requests must use the configured Cloud origin')

    return authedFetch(url, init)
  }
}
