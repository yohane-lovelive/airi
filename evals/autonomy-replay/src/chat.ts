import type { TokenUsage } from './replay'

import { array, nullish, number, object, parse, string } from 'valibot'

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
}

const responseSchema = object({
  choices: array(object({ message: object({ content: nullish(string()) }) })),
  usage: nullish(object({
    prompt_tokens: nullish(number()),
    completion_tokens: nullish(number()),
    prompt_tokens_details: nullish(object({ cached_tokens: nullish(number()) })),
  })),
})

function wireContent(content: ChatMessage['content']) {
  if (typeof content === 'string')
    return content
  return content.map(part => part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${part.base64}` } })
}

/**
 * Sends one chat completion to an OpenAI-compatible endpoint, for example OpenCode Go.
 *
 * The replay reads the cached input tokens of the response, which the xsAI usage type leaves out, so it calls the
 * endpoint itself. Resolves to the reply text and the tokens.
 */
export async function complete(connection: ChatConnection, messages: readonly ChatMessage[], signal?: AbortSignal): Promise<{ text: string, usage: TokenUsage }> {
  const response = await fetch(`${connection.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${connection.apiKey}`, 'Content-Type': 'application/json' },
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
