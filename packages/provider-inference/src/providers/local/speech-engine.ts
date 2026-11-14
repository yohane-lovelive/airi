/**
 * Helpers for a local speech engine that does not speak the OpenAI speech API.
 *
 * Such a provider passes its own `fetch` to `generateSpeech`. That `fetch` reads
 * the body that `generateSpeech` built, and sends the request of the engine.
 */

/** Returns why a Base URL is not usable, or an empty string for a usable one. */
export function absoluteUrlError(baseUrl: string, defaultBaseUrl: string) {
  if (!baseUrl)
    return `Base URL is required. Default to ${defaultBaseUrl} for this engine.`

  try {
    const url = new URL(baseUrl)
    // Check the scheme as well as the host. `ftp://engine/` parses and has a
    // host, so a host-only check accepts an address `fetch` cannot use, and then
    // asks the user for a scheme they already gave.
    if (!url.host || (url.protocol !== 'http:' && url.protocol !== 'https:'))
      return 'Base URL is not absolute. Try to include a scheme (http:// or https://).'
  }
  catch {
    return 'Base URL is not absolute. Try to include a scheme (http:// or https://).'
  }

  return ''
}

/**
 * Reads the segment text, the model, and the voice id out of the OpenAI-shaped
 * body that `generateSpeech` builds.
 *
 * `requestBody` in `@xsai/shared` passes that object through `objCamelToSnake`.
 * Only single-word keys survive unchanged, for example `input`, `model`, and
 * `voice`. A key of more than one word arrives renamed. The synthesis parameters
 * therefore come from the provider configuration, not from this body.
 */
export function readSpeechRequest(init: RequestInit | undefined): { input: string, model?: string, voice: string } {
  if (!init?.body || typeof init.body !== 'string')
    throw new Error('Invalid speech request body')

  const body = JSON.parse(init.body) as { input?: string, model?: string, voice?: string }
  if (!body.voice)
    throw new Error('No voice selected. Pick a voice in the speech settings.')

  return { input: body.input ?? '', model: body.model, voice: body.voice }
}
