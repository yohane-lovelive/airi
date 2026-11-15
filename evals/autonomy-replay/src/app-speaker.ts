import type { ChatHistoryItem } from '@proj-airi/core-agent'

import type { ChatConnection } from './chat'
import type { SpokenReply, TokenUsage } from './replay'
import type { RequestStart } from './request-start'

import { createChatOrchestratorRuntime, FINAL_ANSWER_RULE, SCENE_ANCHOR_TEXT, streamFrom } from '@proj-airi/core-agent'

import { speakingProvider } from './chat'

/** The one conversation of a replay. The app sends autonomous turns to the conversation that the owner has open. */
const SESSION_ID = 'replay'

/** The source name of an autonomous turn in the app (`INITIATIVE_SOURCE` of stage-ui). */
const NOTICE_SOURCE = 'initiative'

/** What a tool call gets in a replay. No tool runs, because a replay must not change memories, missions, or the web. */
const TOOL_RESULT = 'This tool is off in this run. Go on without it.'

/** One decision turn, with its images read from the disk. */
export interface SpeakerTurn {
  /** The time of the turn on the clock of the recording. Stored messages and the time notes of the request use it. */
  readonly at: number
  readonly notice: string
  /** The marker that ends the reply, as the notice asks for it. Without it, the runtime keeps everything that the model writes. */
  readonly endMarker?: 'NEXT' | 'TOPIC'
  /** The images that go with the notice as JPEG base64, oldest first. */
  readonly images: readonly string[]
  /** The anchor frame of the scene as JPEG base64. It goes right after the system prompt. */
  readonly anchor?: string
}

/** What the turn in flight told so far. */
interface TurnReadout {
  /** The usage of each model request of the turn. A turn with a tool call has more than one. */
  readonly usages: Promise<TokenUsage | undefined>[]
  text: string
  toolCalls: number
  firstTextMs?: number
  /** The runtime dropped text that the model wrote after the end marker of its reply. */
  cut?: boolean
}

/**
 * Speaks the turns of one replay through the chat runtime of the app, so each request has the form that the app sends.
 *
 * - The runtime composes the request: the system prompt, the anchor, the lines that the character spoke before, and
 *   the notice with its images. A change of that order in `@proj-airi/core-agent` reaches the replay too.
 * - The notice is transient, as in the app. So the conversation keeps only the lines, and a silent turn leaves nothing.
 * - The conversation lives in memory for one replay. Create one speaker for each replay.
 * - Without `requestStart`, the system prompt is `persona` and the request has no tools.
 * - The runtime ends each system prompt with its final answer rule. A request start of the app holds the rule already,
 *   so the speaker takes it off there.
 *
 * Not in the request, although the app sends them: the summary of a long history, runtime contexts, and stickers.
 * They belong to stores of the app that a replay cannot load.
 */
export function createAppSpeaker(options: {
  connection: ChatConnection
  /** The id that the reply categorizer knows the provider by. */
  providerId: string
  persona: string
  requestStart?: RequestStart
  /** Fields for the request body of the speaking model. See `speakingProvider`. */
  requestFields?: Readonly<Record<string, unknown>>
  /**
   * The most output tokens of one model request. The app sets no limit, so a limit changes what a replay measures.
   * It keeps the cost of a run in bounds when the model does not stop.
   *
   * @default undefined, no limit
   */
  maxOutputTokens?: number
  fetch?: typeof globalThis.fetch
}) {
  const messages: ChatHistoryItem[] = []
  let clock = 0
  /** A replay runs one turn at a time, so one readout is enough. */
  let current: TurnReadout | undefined

  const chatProvider = speakingProvider(options.connection, {
    ...(options.requestFields ? { requestFields: options.requestFields } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    onRequest: request => current?.usages.push(request.usage),
  })
  // The runtime adds the rule to each request. A request start of the app was read after that step.
  const systemPrompt = options.requestStart?.systemPrompt.replace(`\n\n${FINAL_ANSWER_RULE}`, '') ?? options.persona
  const tools = options.requestStart?.tools.map(tool => ({
    ...tool,
    execute: async () => {
      if (current)
        current.toolCalls += 1
      return TOOL_RESULT
    },
  }))

  const runtime = createChatOrchestratorRuntime({
    session: {
      getSessionMessages: () => [...messages],
      commitUserMessage: async (_sessionId, message) => {
        messages.push(message)
        return { status: 'inserted', messageId: message.id }
      },
      commitAssistantMessage: async (_sessionId, message) => {
        const index = messages.findIndex(stored => stored.id === message.id)
        if (index < 0)
          messages.push(message)
        else
          messages[index] = message
      },
      getSessionGeneration: () => 0,
    },
    context: { ingest: () => {}, snapshot: () => ({}) },
    foregroundStream: { patch: () => {}, reset: () => {} },
    llm: { stream: (model, provider, conversation, streamOptions) => streamFrom({ model, chatProvider: provider, conversation, options: streamOptions }) },
    getActiveSessionId: () => SESSION_ID,
    getActiveProvider: () => options.providerId,
    getSystemPrompt: () => systemPrompt,
    now: () => clock,
    onLlmFirstToken: (event) => {
      if (current)
        current.firstTextMs ??= event.ttfbMs
    },
    onReplyCut: () => {
      if (current)
        current.cut = true
    },
  })
  // The whole text of the reply, with its markers. The replay reads the timeline and `NEXT` markers from it.
  runtime.hooks.onAssistantResponseEnd(async (text) => {
    if (current)
      current.text = text
  })

  return {
    /** The lines that the conversation holds so far, as the next request sends them. */
    history: (): readonly ChatHistoryItem[] => messages,

    /**
     * Runs one turn and resolves to what the model answered. Rejects when the model call fails.
     * `firstTextMs` is the time from the start of the request to the first text, as the app measures it. An empty reply
     * has none.
     */
    async speak(turn: SpeakerTurn, signal?: AbortSignal): Promise<SpokenReply> {
      clock = turn.at
      const readout: TurnReadout = { usages: [], text: '', toolCalls: 0 }
      current = readout
      const startedAt = performance.now()
      try {
        await runtime.ingest(turn.notice, {
          model: options.connection.model,
          chatProvider,
          providerId: options.providerId,
          supportsVisionInput: true,
          attachments: turn.images.map(data => ({ type: 'image', mimeType: 'image/jpeg', data })),
          // The app resolves the settings of the character before each model request, and the tools go with them.
          resolveStep: async () => ({
            model: options.connection.model,
            chatProvider,
            providerId: options.providerId,
            systemPrompt,
            ...(tools?.length ? { tools } : {}),
            ...(options.maxOutputTokens ? { maxTokens: options.maxOutputTokens } : {}),
          }),
          ...(signal ? { signal } : {}),
          notice: {
            source: NOTICE_SOURCE,
            transient: true,
            ...(turn.endMarker ? { endMarker: turn.endMarker } : {}),
            ...(turn.anchor ? { anchor: { text: SCENE_ANCHOR_TEXT, image: `data:image/jpeg;base64,${turn.anchor}` } } : {}),
          },
        }, SESSION_ID)
      }
      finally {
        current = undefined
      }
      const durationMs = Math.round(performance.now() - startedAt)
      const usages = (await Promise.all(readout.usages)).filter(usage => usage !== undefined)
      return {
        text: readout.text,
        usage: {
          input: usages.reduce((sum, usage) => sum + usage.input, 0),
          output: usages.reduce((sum, usage) => sum + usage.output, 0),
          cached: usages.reduce((sum, usage) => sum + usage.cached, 0),
        },
        durationMs,
        requests: readout.usages.length,
        toolCalls: readout.toolCalls,
        ...(readout.cut ? { cut: true } : {}),
        // An empty reply can still send an empty text chunk, and that is not the start of a line.
        ...(readout.firstTextMs !== undefined && readout.text.trim() ? { firstTextMs: readout.firstTextMs } : {}),
      }
    },
  }
}
