# @proj-airi/evals-autonomy-replay

A [vieval](https://vieval.dev/) suite that replays screen recordings through the autonomous speech of AIRI. It is the replay evaluation of [the autonomy ADR](../../docs/ai/adr/2026-10-28-autonomous-character-perception-and-missions.md).

For each recording, it runs the screen detectors, the initiative policy, and a frame policy on the clock of the recording. Each decision turn goes to the speaking model with the frames that the policy picked. A judge model then checks each line.

## How to use it

1. Record the screen in the desktop app: Settings > Developer > Screen Recorder.
2. Copy `.env.example` to `.env.test`, and set `AUTONOMY_REPLAY_BASE_URL` and `AUTONOMY_REPLAY_API_KEY` to the OpenAI-compatible endpoint of OpenCode Go.
3. Set `AUTONOMY_REPLAY_MODELS` to the speaking models to compare, separated by commas. `AUTONOMY_REPLAY_JUDGE_MODEL` sets the judge. Without it, the judge is the speaking model.
4. Run the suite:

```shell
pnpm -F @proj-airi/evals-autonomy-replay eval:run
```

5. To keep the lines of each run, add `--report-out <directory>`. Each case writes `replay.json` with the metrics, the lines, and the timeline.

`AUTONOMY_REPLAY_RECORDINGS` names the folder of the recordings. Without it, the suite reads the recordings folder of the desktop app. `AUTONOMY_REPLAY_MODE` is `idle` or `commentary`.

## Metrics

| Metric | Meaning |
| --- | --- |
| `turnsPerMinute`, `silenceShare` | How often the character tries to talk, and how often it stays quiet. |
| `distinct2`, `typeEntropy` | The variety of the phrases and of the speech types. |
| `topicSimilarity` | The similarity of consecutive lines. Too high means a stuck topic, too low a jump without a link. |
| `imagesPerHour`, `inputTokens`, `outputTokens`, `cachedTokens`, `cacheShare` | What the frames cost in images and tokens. Prices are left out. |
| `groundedShare`, `contradictionShare` | The share of lines that the judge found grounded in the screen, and the share that contradict the timeline. |

## Layout

| Path | Content |
| --- | --- |
| `src/recording.ts` | Reads the recordings that the screen recorder wrote. |
| `src/replay.ts` | Replays one recording. It needs no network, and the tests give it a fake model. |
| `src/chat.ts` | Calls an OpenAI-compatible endpoint, and reads the cached input tokens. |
| `src/judge.ts` | The judge messages, and the reading of its JSON answer. |
| `src/metrics.ts` | The metrics of one replay. |
| `evals/replay.eval.ts` | The task. Each recording runs once for each model and frame policy. |

## When to use it

- Use it before you change a frame policy, the detector thresholds, the commentary pace, or the default speaking model.
- Use it to compare frame policies on the same recording.

## When not to use it

- Do not use it as a unit test. It calls paid models, and it sends the recorded frames to the provider. `pnpm -F @proj-airi/evals-autonomy-replay test:run` runs the tests without network.
- Do not use it on a recording that holds private screens. The exclusion list of the app applies to recordings, but check the frames before a run.
