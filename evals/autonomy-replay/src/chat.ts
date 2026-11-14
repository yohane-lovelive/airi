import type { GenerationProvider } from '@proj-airi/provider-inference'

import type { TokenUsage } from './replay'

import { array, nullish, number, object, parse, safeParse, string } from 'valibot'

/** One part of a user message: text, or a JPEG as base64. */
export type ChatPart = { readonly type: 'text', readonly text: string } | { readonly type: 'image', readonly base64: string }

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string | readonly ChatPart[]
}

export interface ChatConnection {
  readonly baseURL: string
  readonly apiKey: string
  readonly model: string
  /**
   * Headers for every request. OpenCode Go needs `x-opencode-session` and rejects a request without it.
   * See {@link sessionHeaders}.
   */
  readonly headers?: Readonly<Record<string, string>>
}

const usageSchema = object({
  prompt_tokens: nullish(number()),
  completion_tokens: nullish(number()),
  prompt_tokens_details: nullish(object({ cached_tokens: nullish(number()) })),
})

const responseSchema = object({
  choices: array(object({ message: object({ content: nullish(string()) }) })),
  usage: nullish(usageSchema),
})

/** One chunk of a streamed reply. Only the chunk before the end holds the usage. */
const chunkSchema = object({ usage: nullish(usageSchema) })

function wireContent(content: ChatMessage['content']) {
  if (typeof content === 'string')
    return content
  return content.map(part => part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${part.base64}` } })
}

/**
 * The headers that name one session at OpenCode Go. The server keeps the cache of a session, so the requests of one
 * replay share an id, and two replays never share one. Another OpenAI-compatible server ignores the header.
 */
export function sessionHeaders(sessionId: string): Record<string, string> {
  return { 'x-opencode-session': sessionId }
}

/**
 * Sends one chat completion to an OpenAI-compatible endpoint, for example OpenCode Go. The judge uses it, because a
 * judgment needs no stream and no history.
 *
 * Resolves to the reply text and the tokens.
 */
export async function complete(connection: ChatConnection, messages: readonly ChatMessage[], signal?: AbortSignal): Promise<{ text: string, usage: TokenUsage }> {
  const response = await fetch(`${connection.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { ...connection.headers, 'Authorization': `Bearer ${connection.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: connection.model, messages: messages.map(message => ({ role: message.role, content: wireContent(message.content) })) }),
    ...(signal ? { signal } : {}),
  })
  if (!response.ok)
    throw new Error(`The model call failed with ${response.status}: ${(await response.text()).slice(0, 300)}`)
  const body = parse(responseSchema, await response.json())
  return {
    text: body.choices[0]?.message.content ?? '',
    usage: {
      input: body.usage?.prompt_tokens ?? 0,
      output: body.usage?.completion_tokens ?? 0,
      cached: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  }
}

/** Reads the usage of a streamed reply from a copy of its body. A body without usage resolves to `undefined`. */
async function streamedUsage(body: ReadableStream<Uint8Array>): Promise<TokenUsage | undefined> {
  const decoder = new TextDecoder()
  let pending = ''
  let usage: TokenUsage | undefined
  const readLines = (lines: string[]) => {
    for (const line of lines) {
      if (!line.startsWith('data:') || !line.includes('"usage"'))
        continue
      try {
        const chunk = safeParse(chunkSchema, JSON.parse(line.slice('data:'.length)))
        if (chunk.success && chunk.output.usage) {
          usage = {
            input: chunk.output.usage.prompt_tokens ?? 0,
            output: chunk.output.usage.completion_tokens ?? 0,
            cached: chunk.output.usage.prompt_tokens_details?.cached_tokens ?? 0,
          }
        }
      }
      catch {
        // A line that is not JSON, for example `data: [DONE]`, holds no usage.
      }
    }
  }
  for await (const bytes of body) {
    const lines = (pending + decoder.decode(bytes, { stream: true })).split('\n')
    pending = lines.pop() ?? ''
    readLines(lines)
  }
  readLines([pending])
  return usage
}

/** One model request that the speaking provider sent, and the usage that its stream reported. */
export interface ObservedRequest {
  /** Resolves when the stream ends. A failed or aborted stream resolves to `undefined`. */
  readonly usage: Promise<TokenUsage | undefined>
}

/**
 * The speaking model as a provider of the app, so the chat runtime of the app can call it.
 *
 * - Every request carries the headers of the connection.
 * - `requestFields` go into the request body as they are, for example `{ reasoningEffort: 'none' }`. The provider of
 *   the app adds the same field from its settings. xsAI writes a camelCase key as snake_case.
 * - `onRequest` hears of each request. The usage of xsAI leaves out the cached input tokens, so the provider reads them
 *   from a copy of the stream.
 */
export function speakingProvider(connection: ChatConnection, options: {
  requestFields?: Readonly<Record<string, unknown>>
  onRequest?: (request: ObservedRequest) => void
  fetch?: typeof globalThis.fetch
} = {}): GenerationProvider {
  const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const observedFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await send(input, init)
    if (!response.ok || !response.body) {
      options.onRequest?.({ usage: Promise.resolve(undefined) })
      return response
    }
    const [forCaller, forUsage] = response.body.tee()
    options.onRequest?.({ usage: streamedUsage(forUsage).catch(() => undefined) })
    return new Response(forCaller, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
  return {
    generation: model => ({
      protocol: 'chat-completions',
      config: {
        ...options.requestFields,
        apiKey: connection.apiKey,
        baseURL: `${connection.baseURL.replace(/\/+$/, '')}/`,
        model,
        headers: { ...connection.headers },
        fetch: observedFetch,
      },
    }),
  }
}
