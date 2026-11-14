import process from 'node:process'

import { describe, expect, it, vi } from 'vitest'

import { createGeminiDecisionClient, DecisionRequestError } from './gemini-decision'

const react = {
  type: 'noul',
  instructions: 'Did something happen on the second screen that a friend would speak about?',
  criteria: { true: 'A clear event happened.', false: 'The same state goes on.' },
} as const

const next = {
  type: 'choice',
  instructions: 'Choose what she does now.',
  criteria: { owner: 'The owner spoke to her.', silent: 'Nothing happened.' },
} as const

/** The Gemini API is the boundary. The fake records the request and gives a fixed reply. */
function setup(reply: unknown, status = 200) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(reply, { status }))
  const client = createGeminiDecisionClient({ apiKey: () => 'test-key', fetch: fetchMock })
  const sentBody = () => JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
  return { client, fetchMock, sentBody }
}

describe('createGeminiDecisionClient', () => {
  it('sends the input and the questions in the form of the Decisions API', async () => {
    const { client, fetchMock, sentBody } = setup({ answers: { react: { type: 'noul', noul: 0.82, confidence: 0.82 } } })

    await client.decide([{ type: 'text', text: 'Two frames follow.' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }], { react })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/decisions')
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('test-key')
    expect(sentBody()).toEqual({
      model: 'gemini-decision-1',
      input: [
        { type: 'text', text: 'Two frames follow.' },
        { type: 'image', data: 'AAAA', mime_type: 'image/jpeg', resolution: 'low' },
      ],
      questions: {
        react: {
          type: 'noul',
          instructions: react.instructions,
          criteria: { true_description: 'A clear event happened.', false_description: 'The same state goes on.' },
        },
      },
    })
  })

  it('gives the chance of yes for a yes or no question, and the input tokens', async () => {
    const { client } = setup({ answers: { react: { type: 'noul', noul: 0.82, confidence: 0.82 } }, usage: { total_input_tokens: 748 } })

    const result = await client.decide([{ type: 'text', text: 'x' }], { react })

    expect(result.answers.react.probability).toBe(0.82)
    expect(result.inputTokens).toBe(748)
  })

  it('gives the chosen option and the chance of each option for a choice', async () => {
    const { client, sentBody } = setup({ answers: { next: { type: 'choice', choice: 'owner', probabilities: { owner: 0.9, silent: 0.1 }, confidence: 0.9 } } })

    const result = await client.decide([{ type: 'text', text: '{"owner_utterance":"hey"}' }], { next })

    expect(sentBody().questions.next).toEqual({ type: 'choice', instructions: next.instructions, criteria: next.criteria })
    expect(result.answers.next.choice).toBe('owner')
    expect(result.answers.next.probabilities).toEqual({ owner: 0.9, silent: 0.1 })
  })

  it('answers several questions of one request by their keys', async () => {
    const { client } = setup({
      answers: {
        next: { type: 'choice', choice: 'silent', probabilities: { owner: 0.2, silent: 0.8 } },
        react: { type: 'noul', noul: 0.1 },
      },
    })

    const result = await client.decide([{ type: 'text', text: 'x' }], { react, next })

    expect(result.answers.react.probability).toBe(0.1)
    expect(result.answers.next.choice).toBe('silent')
  })

  it('rejects with the status when the server refuses, so the caller can wait after 429', async () => {
    const { client } = setup({ error: { message: 'Quota exceeded' } }, 429)

    const failure = await client.decide([{ type: 'text', text: 'x' }], { react }).catch(error => error)

    expect(failure).toBeInstanceOf(DecisionRequestError)
    expect(failure.status).toBe(429)
    expect(failure.message).toContain('Quota exceeded')
  })

  it('rejects when the reply has no answer for a question', async () => {
    const { client } = setup({ answers: {} })

    await expect(client.decide([{ type: 'text', text: 'x' }], { react })).rejects.toThrow('no noul answer for "react"')
  })

  it('rejects a choice that is not an option of the question', async () => {
    const { client } = setup({ answers: { next: { type: 'choice', choice: 'dance', probabilities: { dance: 1 } } } })

    await expect(client.decide([{ type: 'text', text: 'x' }], { next })).rejects.toThrow('not an option')
  })

  it('rejects without a request when no key is set', async () => {
    const fetchMock = vi.fn()
    const client = createGeminiDecisionClient({ apiKey: () => '  ', fetch: fetchMock })

    await expect(client.decide([{ type: 'text', text: 'x' }], { react })).rejects.toThrow('no Gemini API key')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

/**
 * Calls the real API. It needs a key, so CI skips it:
 *
 *   GEMINI_API_KEY=<key> pnpm -F @proj-airi/core-agent exec vitest run src/decision
 */
describe.skipIf(!process.env.GEMINI_API_KEY)('the Gemini Decisions API', () => {
  it('answers a yes or no question and a choice about a text', async () => {
    const client = createGeminiDecisionClient({ apiKey: () => process.env.GEMINI_API_KEY })

    const result = await client.decide([{ type: 'text', text: 'The owner said to the character beside them: "Hey, what do you think about this?"' }], {
      directed: { type: 'noul', instructions: 'Does the owner speak to the character?', criteria: { true: 'The words are for the character.', false: 'The owner talks to nobody.' } },
      next: { type: 'choice', instructions: 'Choose what the character does now.', criteria: { answer: 'The owner spoke to the character.', silent: 'Nobody spoke to the character.' } },
    })

    expect(result.answers.directed.probability).toBeGreaterThan(0.5)
    expect(result.answers.next.choice).toBe('answer')
    expect(result.inputTokens).toBeGreaterThan(0)
  }, 30_000)
})
