import type { ChatConnection } from './chat'

import { describe, expect, it } from 'vitest'

import { createAppSpeaker } from './app-speaker'
import { sessionHeaders } from './chat'

const connection: ChatConnection = { baseURL: 'https://provider.test/v1', apiKey: 'test-key', model: 'gpt-6-luna', headers: sessionHeaders('session-1') }
const AT = Date.UTC(2026, 10, 12, 13, 0, 0)

interface WireMessage { role: string, content: string | { type: string, text?: string, image_url?: { url: string } }[] }
interface WireRequest { url: string, headers: Headers, body: { model: string, stream: boolean, messages: WireMessage[], tools?: { function: { name: string } }[], reasoning_effort?: string, max_tokens?: number } }

/** One streamed reply of an OpenAI-compatible server: the chunks, then the usage, then the end mark. */
function streamOf(chunks: unknown[], usage = { prompt_tokens: 1_000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 600 } }) {
  const events = [...chunks, { choices: [], usage }].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`)
  return new Response(`${events.join('')}data: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
}

function textReply(text: string) {
  return streamOf([{ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }])
}

/** The provider is the boundary. The fake records each request and answers with the next reply. */
function setup(replies: (() => Response)[], options: Partial<Parameters<typeof createAppSpeaker>[0]> = {}) {
  const requests: WireRequest[] = []
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
    return (replies[requests.length - 1] ?? replies.at(-1)!)()
  }
  const speaker = createAppSpeaker({ connection, providerId: 'opencode-go', persona: 'You are AIRI.', fetch, ...options })
  return { speaker, requests }
}

function textOf(message: WireMessage) {
  return typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('')
}

function imagesOf(message: WireMessage) {
  return typeof message.content === 'string' ? [] : message.content.flatMap(part => part.image_url ? [part.image_url.url] : [])
}

describe('createAppSpeaker', () => {
  it('sends a streamed request with the session header, the persona, and the notice with its images', async () => {
    const { speaker, requests } = setup([() => textReply('Nice!')])

    await speaker.speak({ at: AT, notice: 'Mode: commentary', images: ['AAAA', 'BBBB'] })

    const [request] = requests
    expect(request.url).toBe('https://provider.test/v1/chat/completions')
    expect(request.headers.get('x-opencode-session')).toBe('session-1')
    expect(request.headers.get('authorization')).toBe('Bearer test-key')
    expect(request.body.model).toBe('gpt-6-luna')
    expect(request.body.stream).toBe(true)
    expect(request.body.messages[0].role).toBe('system')
    expect(textOf(request.body.messages[0])).toContain('You are AIRI.')
    expect(textOf(request.body.messages.at(-1)!)).toContain('Mode: commentary')
    expect(imagesOf(request.body.messages.at(-1)!)).toEqual(['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB'])
  })

  it('resolves to the text, the tokens with the cached ones, and the time to the first text', async () => {
    const { speaker } = setup([() => textReply('Nice! <|NOTE boss down|>')])

    const reply = await speaker.speak({ at: AT, notice: 'Mode: commentary', images: [] })

    expect(reply.text).toBe('Nice! <|NOTE boss down|>')
    expect(reply.usage).toEqual({ input: 1_000, output: 20, cached: 600 })
    expect(reply.requests).toBe(1)
    expect(reply.toolCalls).toBe(0)
    expect(reply.firstTextMs).toBeGreaterThanOrEqual(0)
    expect(reply.durationMs).toBeGreaterThanOrEqual(reply.firstTextMs!)
  })

  it('keeps the spoken line for the next request, and drops the notice and its images', async () => {
    const { speaker, requests } = setup([() => textReply('First line.'), () => textReply('Second line.')])

    await speaker.speak({ at: AT, notice: 'NOTICE-ONE', images: ['AAAA'] })
    await speaker.speak({ at: AT + 10_000, notice: 'NOTICE-TWO', images: ['BBBB'] })

    const second = requests[1].body.messages
    expect(second.map(message => message.role)).toEqual(['system', 'assistant', 'user'])
    expect(textOf(second[1])).toContain('First line.')
    expect(second.some(message => textOf(message).includes('NOTICE-ONE'))).toBe(false)
    expect(second.flatMap(imagesOf)).toEqual(['data:image/jpeg;base64,BBBB'])
  })

  it('keeps nothing of a silent turn', async () => {
    const { speaker, requests } = setup([() => textReply(''), () => textReply('Now I speak.')])

    const silent = await speaker.speak({ at: AT, notice: 'NOTICE-ONE', images: [] })
    await speaker.speak({ at: AT + 10_000, notice: 'NOTICE-TWO', images: [] })

    expect(silent.text).toBe('')
    expect(silent.firstTextMs).toBeUndefined()
    expect(requests[1].body.messages.map(message => message.role)).toEqual(['system', 'user'])
  })

  it('puts the anchor of the scene right after the system prompt', async () => {
    const { speaker, requests } = setup([() => textReply('First line.'), () => textReply('Second line.')])

    await speaker.speak({ at: AT, notice: 'NOTICE-ONE', images: ['AAAA'], anchor: 'ANCH' })
    await speaker.speak({ at: AT + 10_000, notice: 'NOTICE-TWO', images: ['BBBB'], anchor: 'ANCH' })

    const second = requests[1].body.messages
    expect(second.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(imagesOf(second[1])).toEqual(['data:image/jpeg;base64,ANCH'])
    expect(textOf(second[1])).toContain('anchor frame of the current scene')
  })

  it('sends the system prompt and the tools of the app when it has the start of a request', async () => {
    const requestStart = {
      systemPrompt: 'The whole prompt of the app.',
      tools: [{ type: 'function' as const, function: { name: 'memory_search', description: 'Searches memories.', parameters: { type: 'object', properties: {} } } }],
    }
    const { speaker, requests } = setup([() => textReply('Nice!')], { requestStart })

    await speaker.speak({ at: AT, notice: 'Mode: commentary', images: [] })

    expect(textOf(requests[0].body.messages[0])).toContain('The whole prompt of the app.')
    expect(textOf(requests[0].body.messages[0])).not.toContain('You are AIRI.')
    expect(requests[0].body.tools?.map(tool => tool.function.name)).toEqual(['memory_search'])
  })

  it('answers a tool call with a fixed text, and counts the second request and its tokens', async () => {
    const requestStart = {
      systemPrompt: 'The whole prompt of the app.',
      tools: [{ type: 'function' as const, function: { name: 'memory_search', parameters: { type: 'object', properties: {} } } }],
    }
    const toolCall = () => streamOf([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'memory_search', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }])
    const { speaker, requests } = setup([toolCall, () => textReply('I remember.')], { requestStart })

    const reply = await speaker.speak({ at: AT, notice: 'Mode: commentary', images: [] })

    expect(reply.text).toBe('I remember.')
    expect(reply.requests).toBe(2)
    expect(reply.toolCalls).toBe(1)
    expect(reply.usage).toEqual({ input: 2_000, output: 40, cached: 1_200 })
    expect(textOf(requests[1].body.messages.at(-1)!)).toContain('This tool is off in this run.')
  })

  it('adds the request fields of the model to the body, so reasoning can be off as in the app', async () => {
    const { speaker, requests } = setup([() => textReply('Nice!')], { requestFields: { reasoningEffort: 'none' } })

    await speaker.speak({ at: AT, notice: 'Mode: commentary', images: [] })

    expect(requests[0].body.reasoning_effort).toBe('none')
  })

  it('sends no output limit, as the app, unless the run sets one', async () => {
    const free = setup([() => textReply('Nice!')])
    const limited = setup([() => textReply('Nice!')], { maxOutputTokens: 400 })

    await free.speaker.speak({ at: AT, notice: 'Mode: commentary', images: [] })
    await limited.speaker.speak({ at: AT, notice: 'Mode: commentary', images: [] })

    expect(free.requests[0].body.max_tokens).toBeUndefined()
    expect(limited.requests[0].body.max_tokens).toBe(400)
  })

  it('rejects when the provider refuses the request', async () => {
    const { speaker } = setup([() => new Response('{"error":{"message":"missing session"}}', { status: 400 })])

    await expect(speaker.speak({ at: AT, notice: 'Mode: commentary', images: [] })).rejects.toThrow()
  })
})
