import process from 'node:process'

import { createGeminiDecisionClient, SCREEN_GATE, SCREEN_GATE_QUESTION, screenGateInput } from '@proj-airi/core-agent'
import { describeTask, expect } from 'vieval'

import { loadGateLabels, scoreGate, traceGate } from '../src/gate'
import { defaultRecordingsDirectory, loadRecordings } from '../src/recording'

/** The thresholds of the table in the artifact, so a run shows what another threshold would do. */
const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]

const recordings = loadRecordings(process.env.AUTONOMY_REPLAY_RECORDINGS || defaultRecordingsDirectory())

describeTask('screen-gate', ({ casesFromInputs }) => {
  casesFromInputs('recording', recordings.map(recording => ({ name: recording.id, recording })), async (context) => {
    const { recording } = context.matrix.inputs
    const client = createGeminiDecisionClient({ apiKey: () => process.env.GEMINI_API_KEY })

    const looks = await traceGate(recording, {
      signal: context.signal,
      ask: async (previous, current, signal) => {
        const result = await client.decide(screenGateInput(previous, current), { react: SCREEN_GATE_QUESTION }, signal)
        return { probability: result.answers.react.probability, inputTokens: result.inputTokens }
      },
    })

    // A recording with `labels.json` gets the shares of the events. Another one gets the pass rates only.
    const labels = loadGateLabels(recording)
    const startedAt = recording.frames[0]?.at ?? recording.startedAt
    const score = scoreGate(looks, labels, { startedAt, threshold: SCREEN_GATE.threshold })
    for (const [name, value] of Object.entries(score)) {
      if (typeof value === 'number')
        context.recordMetric(name, value)
    }
    context.recordMetric('inputTokensPerLook', looks.length ? looks.reduce((sum, look) => sum + look.inputTokens, 0) / looks.length : 0)
    await context.recordArtifact('gate.json', {
      body: `${JSON.stringify({
        recording: recording.id,
        looks: looks.length,
        labels: labels ? { events: labels.length, important: labels.filter(label => label.important).length } : null,
        score,
        thresholds: THRESHOLDS.map(threshold => scoreGate(looks, labels, { startedAt, threshold })),
        probabilities: looks.map(look => ({ second: Math.round((look.at - startedAt) / 1000), probability: Number(look.probability.toFixed(3)) })),
      }, null, 2)}\n`,
      contentType: 'application/json',
      purpose: 'autonomy_replay.gate',
    })

    expect(looks.length).toBeGreaterThan(0)
  })
})
