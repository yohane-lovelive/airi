/**
 * The HTTP contract of Irodori-TTS-Server, the OpenAI-compatible server of Irodori-TTS.
 *
 * https://github.com/Aratako/Irodori-TTS-Server
 *
 * The server keeps reference clips in its voices folder. A request names the clips
 * by the paths that the server reports, so the paths always resolve on the server.
 */

/** Server voice ids that start with this prefix are reference clips that AIRI uploaded. */
export const IRODORI_CLIP_ID_PREFIX = 'airi-'

/** The extensions that the server accepts for an uploaded clip. */
export const IRODORI_CLIP_EXTENSIONS = ['.wav', '.flac', '.mp3', '.m4a', '.ogg', '.opus', '.aac', '.webm'] as const

export interface IrodoriServerConfig {
  apiKey?: string
  baseUrl: string
}

/** One entry of `GET /v1/audio/voices`. */
export interface IrodoriServerVoice {
  id: string
  no_ref?: boolean
  ref_wav?: null | string
  ref_wavs?: null | string[]
}

/** The `irodori` object of a speech request. Only the fields that AIRI sets are named. */
export interface IrodoriSynthesisOptions {
  caption?: string
  num_steps?: number
  ref_wavs?: string[]
}

export interface IrodoriSpeechRequest {
  input: string
  irodori: IrodoriSynthesisOptions
  model: string
  speed?: number
  /** Omitted when `irodori.ref_wavs` names the reference. */
  voice?: string
}

export interface IrodoriRequestOptions {
  signal?: AbortSignal
}

function endpoint(config: IrodoriServerConfig, path: string) {
  return new URL(path, config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`)
}

function headers(config: IrodoriServerConfig, init?: Record<string, string>) {
  const apiKey = config.apiKey?.trim()
  return {
    ...init,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }
}

/** Reads the message of the error envelope that the server returns. */
async function failure(response: Response, action: string) {
  const text = await response.text().catch(() => '')
  let message = text
  try {
    const body = JSON.parse(text) as { detail?: unknown, error?: { message?: unknown } }
    const detail = body.error?.message ?? body.detail
    if (detail !== undefined)
      message = typeof detail === 'string' ? detail : JSON.stringify(detail)
  }
  catch {}

  return new Error(`Irodori-TTS ${action} failed: HTTP ${response.status}${message ? ` ${message}` : ''}`)
}

/** Lists the voices of the server: files in its voices folder, `voices.json` aliases, and `none`. */
export async function fetchIrodoriVoices(config: IrodoriServerConfig, options: IrodoriRequestOptions = {}): Promise<IrodoriServerVoice[]> {
  const response = await fetch(endpoint(config, 'audio/voices'), { headers: headers(config), signal: options.signal })
  if (!response.ok)
    throw await failure(response, 'voice list')

  const body = await response.json() as { data?: IrodoriServerVoice[] }
  return body.data ?? []
}

/** Reads the model id that the server answers to. */
export async function fetchIrodoriModels(config: IrodoriServerConfig, options: IrodoriRequestOptions = {}): Promise<string[]> {
  const response = await fetch(endpoint(config, 'models'), { headers: headers(config), signal: options.signal })
  if (!response.ok)
    throw await failure(response, 'model list')

  const body = await response.json() as { data?: Array<{ id: string }> }
  return (body.data ?? []).map(model => model.id)
}

/** Asks `/health`, which answers without a key and without loading the model. */
export async function fetchIrodoriHealth(config: IrodoriServerConfig, options: IrodoriRequestOptions = {}) {
  // `/health` sits at the server root, outside `/v1/`.
  const response = await fetch(new URL('/health', config.baseUrl), { signal: options.signal })
  if (!response.ok)
    throw await failure(response, 'health check')
}

/**
 * Returns the server paths of the clips, in the order of the ids.
 *
 * The server rescans its voices folder on each request, so a clip that someone
 * deleted on the server is reported here, not as a failed synthesis.
 */
export async function resolveIrodoriClipPaths(config: IrodoriServerConfig, clipIds: string[], options: IrodoriRequestOptions = {}) {
  const voices = new Map((await fetchIrodoriVoices(config, options)).map(voice => [voice.id, voice]))

  return clipIds.map((clipId) => {
    const path = voices.get(clipId)?.ref_wav
    if (!path)
      throw new Error(`The reference clip ${clipId} is not on the Irodori-TTS server. Add the clip again.`)

    return path
  })
}

/** Sends one synthesis request. The server answers with one WAV file. */
export async function synthesizeIrodoriSpeech(config: IrodoriServerConfig, request: IrodoriSpeechRequest, options: IrodoriRequestOptions = {}) {
  const response = await fetch(endpoint(config, 'audio/speech'), {
    body: JSON.stringify({ ...request, response_format: 'wav' }),
    headers: headers(config, { 'Content-Type': 'application/json' }),
    method: 'POST',
    signal: options.signal,
  })
  if (!response.ok)
    throw await failure(response, 'speech')

  return response
}

/**
 * Stores one reference clip on the server as the voice `clipId`.
 *
 * The server keeps the extension of `fileName`, and refuses an extension that is
 * not in {@link IRODORI_CLIP_EXTENSIONS}.
 */
export async function uploadIrodoriClip(config: IrodoriServerConfig, clipId: string, file: Blob, fileName: string, options: IrodoriRequestOptions = {}) {
  const form = new FormData()
  form.append('voice_id', clipId)
  form.append('file', file, fileName)

  const response = await fetch(endpoint(config, 'audio/voices'), { body: form, headers: headers(config), method: 'POST', signal: options.signal })
  if (!response.ok)
    throw await failure(response, 'clip upload')
}

/** Deletes one reference clip. A clip that is already gone counts as deleted. */
export async function deleteIrodoriClip(config: IrodoriServerConfig, clipId: string, options: IrodoriRequestOptions = {}) {
  const response = await fetch(endpoint(config, `audio/voices/${encodeURIComponent(clipId)}`), { headers: headers(config), method: 'DELETE', signal: options.signal })
  if (!response.ok && response.status !== 404)
    throw await failure(response, 'clip delete')
}
