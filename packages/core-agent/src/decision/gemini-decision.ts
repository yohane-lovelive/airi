import type { InferOutput } from 'valibot'

import type { DecisionQuestion } from '../runtime/recipe'

import { literal, number, object, optional, parse, record, string, variant } from 'valibot'

/** The endpoint of the Gemini Decisions API. */
const DECISIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/decisions'

/** The decision model. It answers questions with probabilities and writes no text. */
const DECISION_MODEL = 'gemini-decision-1'

/** One part of the material that the questions are about. The model reads the parts in their order. */
export type DecisionModelInput
  = | { type: 'text', text: string }
    | {
      type: 'image'
      /** The image bytes as base64, without a data URL prefix. */
      data: string
      mimeType: string
      /**
       * How many tokens the image costs: 264, 527, or 1,100. A question about what happens on a screen needs `low`.
       *
       * @default 'low'
       */
      resolution?: 'low' | 'medium' | 'high'
    }

/**
 * The answer of the model to one question. The question has the form of a recipe decision: yes or no, or a choice.
 *
 * - A yes or no question gives `probability`, the chance of yes from 0 to 1. The caller compares it with its own limit.
 * - A choice gives the best option and the chance of each option. The options are the keys of `criteria`, and their
 *   chances sum to 1.
 */
export type DecisionModelAnswer<Question extends DecisionQuestion> = Question extends { type: 'choice', criteria: infer Criteria }
  ? { choice: keyof Criteria & string, probabilities: Record<keyof Criteria & string, number> }
  : { probability: number }

/** The answers of one request, by the key of each question, and the input tokens that the request cost. */
export interface DecisionModelResult<Questions extends Record<string, DecisionQuestion>> {
  answers: { [Key in keyof Questions]: DecisionModelAnswer<Questions[Key]> }
  inputTokens: number
}

/** The request failed at the server. `status` lets the caller wait after 429 and give up after 400. */
export class DecisionRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'DecisionRequestError'
  }
}

const answerSchema = variant('type', [
  object({ type: literal('noul'), noul: number() }),
  object({ type: literal('choice'), choice: string(), probabilities: record(string(), number()) }),
])

const responseSchema = object({
  answers: record(string(), answerSchema),
  usage: optional(object({ total_input_tokens: optional(number()) })),
})

function toWireQuestion(question: DecisionQuestion) {
  if (question.type === 'noul') {
    return {
      type: 'noul',
      instructions: question.instructions,
      criteria: { true_description: question.criteria.true, false_description: question.criteria.false },
    }
  }
  return question
}

function toWireInput(part: DecisionModelInput) {
  if (part.type === 'text')
    return part
  return { type: 'image', data: part.data, mime_type: part.mimeType, resolution: part.resolution ?? 'low' }
}

function readAnswer(key: string, question: DecisionQuestion, answer: InferOutput<typeof answerSchema> | undefined) {
  if (answer?.type !== question.type)
    throw new Error(`The decision model gave no ${question.type} answer for "${key}".`)
  if (answer.type === 'noul')
    return { probability: answer.noul }
  // The model can only name a key of the request. Another value means that the reply is not for this request.
  if (question.type === 'choice' && !Object.hasOwn(question.criteria, answer.choice))
    throw new Error(`The decision model chose "${answer.choice}" for "${key}", which is not an option.`)
  return { choice: answer.choice, probabilities: answer.probabilities }
}

/**
 * Creates the client of Gemini Decision 1, the model that judges and writes no text.
 *
 * Use when:
 * - Code needs a judgement on text or images before it calls the chat model, for example whether the screen shows a
 *   moment to speak.
 *
 * The questions of one request cannot see each other. Compare numbers and times in code, and give the model the result
 * as a named value, for example `long_silence`. An image pulls a choice toward what the image shows, so a choice
 * about what to do next reads text only.
 *
 * @param options The values of the host.
 * @param options.apiKey Reads the Gemini API key at each request, so a key that the owner changes applies at once.
 * @param options.fetch The request function. A browser page can call the API directly.
 * @default options.fetch `globalThis.fetch`
 */
export function createGeminiDecisionClient(options: {
  apiKey: () => string | undefined
  fetch?: typeof globalThis.fetch
}) {
  const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init))

  return {
    /**
     * Asks the questions about the input in one request.
     *
     * Rejects without a key, with a {@link DecisionRequestError} when the server refuses, and when the reply lacks
     * an answer. The caller decides what a failed judgement means. The client does not retry.
     */
    async decide<Questions extends Record<string, DecisionQuestion>>(input: readonly DecisionModelInput[], questions: Questions, signal?: AbortSignal): Promise<DecisionModelResult<Questions>> {
      const apiKey = options.apiKey()?.trim()
      if (!apiKey)
        throw new Error('The decision model has no Gemini API key.')

      const response = await send(DECISIONS_URL, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: DECISION_MODEL,
          input: input.map(toWireInput),
          questions: Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, toWireQuestion(question)])),
        }),
        signal,
      })
      if (!response.ok)
        throw new DecisionRequestError(response.status, `The decision model answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)

      const reply = parse(responseSchema, await response.json())
      const answers = Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, readAnswer(key, question, reply.answers[key])]))
      return {
        // `readAnswer` gives each key the answer form of its question. `Object.fromEntries` loses that link.
        answers: answers as unknown as DecisionModelResult<Questions>['answers'],
        inputTokens: reply.usage?.total_input_tokens ?? 0,
      }
    },
  }
}

/** The client that {@link createGeminiDecisionClient} returns. */
export type GeminiDecisionClient = ReturnType<typeof createGeminiDecisionClient>
