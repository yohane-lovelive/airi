import type { FramePolicyName } from '@proj-airi/stage-shared/perception'

import type { LineJudgment } from '../src/metrics'
import type { ReplayTurn } from '../src/replay'

import process from 'node:process'

import { SCENE_ANCHOR_TEXT } from '@proj-airi/core-agent'
import { FRAME_POLICY_NAMES } from '@proj-airi/stage-shared/perception'
import { parse, picklist } from 'valibot'
import { describeTask, expect } from 'vieval'
import { modelFromRun, openaiFromRunContext } from 'vieval/plugins/chat-models'

import { complete } from '../src/chat'
import { renderContactSheet } from '../src/contact-sheet'
import { judgeMessages, parseJudgment } from '../src/judge'
import { replayMetrics } from '../src/metrics'
import { defaultRecordingsDirectory, frameImage, loadRecordings } from '../src/recording'
import { replayRecording } from '../src/replay'

const recordings = loadRecordings(process.env.AUTONOMY_REPLAY_RECORDINGS || defaultRecordingsDirectory())
const mode = parse(picklist(['idle', 'commentary']), process.env.AUTONOMY_REPLAY_MODE || 'idle')
const persona = process.env.AUTONOMY_REPLAY_PERSONA
  || 'You are AIRI, a cheerful character who lives on the owner\'s desktop and sees the owner\'s screen. Speak Japanese.'

describeTask('autonomy-replay', ({ casesFromInputs }) => {
  casesFromInputs('recording', recordings.map(recording => ({ name: recording.id, recording })), async (context) => {
    const { recording } = context.matrix.inputs
    const connection = openaiFromRunContext(modelFromRun(context, { axis: 'model' }))
    const baseURL = connection.baseURL ?? ''
    const policy: FramePolicyName = parse(picklist(FRAME_POLICY_NAMES), context.task.matrix.run.policy)
    const judgeModel = process.env.AUTONOMY_REPLAY_JUDGE_MODEL || connection.model

    // The request has the shape that the app sends: the anchor right after the system prompt, then the notice with
    // its single frames or its contact sheet.
    const speak = async (turn: ReplayTurn) => {
      const images = await Promise.all(turn.frames.map(frame => frameImage(recording, frame)))
      if (turn.sheet)
        images.push(await renderContactSheet(await Promise.all(turn.sheet.map(frame => frameImage(recording, frame)))))
      const anchor = turn.anchor ? await frameImage(recording, turn.anchor) : undefined
      return complete({ baseURL, apiKey: connection.apiKey, model: connection.model }, [
        { role: 'system', content: persona },
        ...(anchor ? [{ role: 'user' as const, content: [{ type: 'text' as const, text: SCENE_ANCHOR_TEXT }, { type: 'image' as const, base64: anchor }] }] : []),
        { role: 'user', content: [{ type: 'text', text: turn.notice }, ...images.map(base64 => ({ type: 'image' as const, base64 }))] },
      ], context.signal)
    }
    const result = await replayRecording(recording, { mode, policy, seed: 1 }, speak)

    // The judge sees the frames before each line and the screen right after it.
    const judgments: LineJudgment[] = []
    for (const line of result.lines) {
      const after = recording.frames.find(frame => frame.at > line.at + 2_000) ?? recording.frames.at(-1)
      const images = await Promise.all([...line.frames, ...(after ? [after] : [])].map(frame => frameImage(recording, frame)))
      const answer = await complete({ baseURL, apiKey: connection.apiKey, model: judgeModel }, judgeMessages({ line: line.text, images, timeline: result.timeline }), context.signal)
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
      body: `${JSON.stringify({ recording: recording.id, model: connection.model, judgeModel, policy, mode, metrics, lines: result.lines.map(line => ({ at: line.at, trigger: line.trigger, speechType: line.speechType, text: line.text, frames: line.frames.map(frame => frame.file) })), timeline: result.timeline }, null, 2)}\n`,
      contentType: 'application/json',
      purpose: 'autonomy_replay.output',
    })

    expect(result.turns).toBeGreaterThan(0)
  })
})
