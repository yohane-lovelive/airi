import type { FramePolicyName } from '@proj-airi/stage-shared/perception'

import type { LineJudgment } from '../src/metrics'
import type { ReplayTurn } from '../src/replay'

import process from 'node:process'

import { randomUUID } from 'node:crypto'

import { FRAME_POLICY_NAMES } from '@proj-airi/stage-shared/perception'
import { integer, minValue, number, parse, picklist, pipe, record, string, unknown } from 'valibot'
import { describeTask, expect } from 'vieval'
import { modelFromRun, openaiFromRunContext } from 'vieval/plugins/chat-models'

import { createAppSpeaker } from '../src/app-speaker'
import { complete, sessionHeaders } from '../src/chat'
import { renderContactSheet, scaleFrame } from '../src/contact-sheet'
import { judgeMessages, parseJudgment } from '../src/judge'
import { replayMetrics } from '../src/metrics'
import { defaultRecordingsDirectory, frameImage, loadCast, loadRecordings } from '../src/recording'
import { replayRecording } from '../src/replay'
import { requestStartOf } from '../src/request-start'

/** The judge sees this many images for one line: the newest frames before the line, and the screen after it. */
const JUDGE_IMAGES = 3

/** The app sends the older frames of a turn at this size (`FRAME_LIMITS.smallLongSide` of stage-ui). */
const SMALL_LONG_SIDE = 512

const recordings = loadRecordings(process.env.AUTONOMY_REPLAY_RECORDINGS || defaultRecordingsDirectory())
const mode = parse(picklist(['idle', 'commentary']), process.env.AUTONOMY_REPLAY_MODE || 'idle')
const persona = process.env.AUTONOMY_REPLAY_PERSONA
  || 'You are AIRI, a cheerful character who lives on the owner\'s desktop and sees the owner\'s screen. Speak Japanese.'
// Body fields for each model, for example `{"gpt-6-luna":{"reasoningEffort":"none"}}`. Each model of OpenCode Go reads
// its own reasoning field, and the provider of the app adds it from its settings.
const requestFields = parse(record(string(), record(string(), unknown())), JSON.parse(process.env.AUTONOMY_REPLAY_REQUEST_FIELDS || '{}'))
// The app sets no output limit. A limit keeps the cost of a run in bounds when the model does not stop.
const maxOutputTokens = process.env.AUTONOMY_REPLAY_MAX_OUTPUT_TOKENS
  ? parse(pipe(number(), integer(), minValue(1)), Number(process.env.AUTONOMY_REPLAY_MAX_OUTPUT_TOKENS))
  : undefined

describeTask('autonomy-replay', ({ casesFromInputs }) => {
  casesFromInputs('recording', recordings.map(recording => ({ name: recording.id, recording })), async (context) => {
    const { recording } = context.matrix.inputs
    const connection = openaiFromRunContext(modelFromRun(context, { axis: 'model' }))
    const baseURL = connection.baseURL ?? ''
    const policy: FramePolicyName = parse(picklist(FRAME_POLICY_NAMES), context.task.matrix.run.policy)
    const judgeModel = process.env.AUTONOMY_REPLAY_JUDGE_MODEL || connection.model
    const fieldsOfModel = requestFields[connection.model]
    const requestStart = requestStartOf(recording, process.env.AUTONOMY_REPLAY_REQUEST_START || undefined)

    // The chat runtime of the app composes each request. One session holds the cache of this replay at the server.
    const speaker = createAppSpeaker({
      connection: { baseURL, apiKey: connection.apiKey, model: connection.model, headers: sessionHeaders(randomUUID()) },
      providerId: 'opencode-go',
      persona,
      ...(requestStart ? { requestStart } : {}),
      ...(fieldsOfModel ? { requestFields: fieldsOfModel } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    })
    // As in the app: the newest frame at full size, older frames smaller, and a contact sheet as one image.
    const speak = async (turn: ReplayTurn) => {
      const older = await Promise.all(turn.frames.slice(0, -1).map(async frame => scaleFrame(await frameImage(recording, frame), SMALL_LONG_SIDE)))
      const newest = turn.frames.at(-1)
      // The contact sheet comes before the single frames, as in the app.
      const sheet = turn.sheet?.length ? [await renderContactSheet(await Promise.all(turn.sheet.map(frame => frameImage(recording, frame))))] : []
      const images = [...sheet, ...older, ...(newest ? [await frameImage(recording, newest)] : [])]
      const anchor = turn.anchor ? await frameImage(recording, turn.anchor) : undefined
      return speaker.speak({ at: turn.at, notice: turn.notice, endMarker: turn.endMarker, images, ...(anchor ? { anchor } : {}) }, context.signal)
    }
    // A cast that a person read from the recording, for example from its loading screen. `AUTONOMY_REPLAY_CAST=off` runs without it.
    const cast = process.env.AUTONOMY_REPLAY_CAST === 'off' ? undefined : loadCast(recording)
    const result = await replayRecording(recording, { mode, policy, seed: 1, ...(cast ? { cast } : {}) }, speak)

    // The judge sees the frames before each line and the screen right after it. It has a session of its own.
    const judge = { baseURL, apiKey: connection.apiKey, model: judgeModel, headers: sessionHeaders(randomUUID()) }
    const judgments: LineJudgment[] = []
    for (const line of result.lines) {
      const after = recording.frames.find(frame => frame.at > line.at + 2_000) ?? recording.frames.at(-1)
      const images = await Promise.all([...line.frames, ...(after ? [after] : [])].map(frame => frameImage(recording, frame)))
      // The judge gets at most the last frames of a line, so a contact sheet of six tiles does not flood it.
      const answer = await complete(judge, judgeMessages({ line: line.text, images: images.slice(-JUDGE_IMAGES), timeline: result.timeline, ...(cast ? { cast } : {}) }), context.signal)
      const judgment = parseJudgment(answer.text)
      if (judgment)
        judgments.push(judgment)
    }

    const metrics = replayMetrics(result, judgments)
    for (const [name, value] of Object.entries(metrics)) {
      if (typeof value === 'number')
        context.recordMetric(name, value)
    }
    await context.recordArtifact('replay.json', {
      body: `${JSON.stringify({
        recording: recording.id,
        model: connection.model,
        judgeModel,
        policy,
        mode,
        maxOutputTokens: maxOutputTokens ?? null,
        cast: cast ?? null,
        // Without the start of a request of the app, the request is far smaller than in the app.
        requestStart: requestStart ? { systemPromptChars: requestStart.systemPrompt.length, tools: requestStart.tools.length } : null,
        metrics,
        lines: result.lines.map(line => ({ at: line.at, trigger: line.trigger, speechType: line.speechType, firstTextMs: line.firstTextMs, text: line.text, frames: line.frames.map(frame => frame.file) })),
        timeline: result.timeline,
      }, null, 2)}\n`,
      contentType: 'application/json',
      purpose: 'autonomy_replay.output',
    })

    expect(result.turns).toBeGreaterThan(0)
  })
})
