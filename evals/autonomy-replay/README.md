# @proj-airi/evals-autonomy-replay

A [vieval](https://vieval.dev/) suite that replays screen recordings through the autonomous speech of AIRI. It is the replay evaluation of [the autonomy ADR](../../docs/ai/adr/2026-10-28-autonomous-character-perception-and-missions.md).

It has two tasks.

- **The replay** (`eval:run`) runs the screen detectors, the initiative policy, and a frame policy on the clock of a recording. Each decision turn goes to the speaking model through the chat runtime of the app, so the request has the form that the app sends. A judge model then checks each line.
- **The gate trace** (`eval:gate`) asks the screen gate of [the decision model ADR](../../docs/ai/adr/2026-11-14-autonomy-one-model-relay-decision.md) about a recording, one look each 2 seconds. It tells how often the gate passes, and how many labeled events it catches.

## How to use it

1. Get a recording. Use one of these ways.
   - Record the screen in the desktop app: Settings > Developer > Screen Recorder.
   - Import a play video. This needs `ffmpeg` on the PATH.

     ```shell
     pnpm -F @proj-airi/evals-autonomy-replay import-video <video> --recordings <folder> --app "<app name>"
     ```

2. Copy `.env.example` to `.env.test`, and set `AUTONOMY_REPLAY_BASE_URL` and `AUTONOMY_REPLAY_API_KEY` to the OpenAI-compatible endpoint of OpenCode Go.
3. Set `AUTONOMY_REPLAY_MODELS` to the speaking models to compare, separated by commas. `AUTONOMY_REPLAY_JUDGE_MODEL` sets the judge. Without it, the judge is the speaking model.
4. Run the replay:

   ```shell
   pnpm -F @proj-airi/evals-autonomy-replay eval:run
   ```

5. To keep the lines of each run, add `--report-out <directory>`. Each case writes `replay.json` with the metrics, the lines, and the timeline.
6. For the gate trace, set `GEMINI_API_KEY` and run:

   ```shell
   pnpm -F @proj-airi/evals-autonomy-replay eval:gate
   ```

`AUTONOMY_REPLAY_RECORDINGS` names the folder of the recordings. Without it, the suite reads the recordings folder of the desktop app. `AUTONOMY_REPLAY_MODE` is `idle` or `commentary`.

Each recording runs once for each model and each frame policy. Without `AUTONOMY_REPLAY_POLICIES`, the replay runs `recent-sheet`, the frame policy of a commentary turn of the app. Name other policies of `@proj-airi/stage-shared/perception`, separated by commas, to compare them.

## The request of the app

A replay measures speed and cache only when its requests have the size of the requests of the app. The app sends a long system prompt and its tool definitions with each turn.

- The screen recorder of the app writes `request-start.json` into a recording at each chat request: the system prompt and the tool definitions. The replay of that recording sends them again.
- `AUTONOMY_REPLAY_REQUEST_START` names one such file for every recording. Use it for an imported video, which has no file of its own.
- Without a request start, the system prompt is a short persona and the request has no tools. The time to the first text is then shorter than in the app.
- The chat runtime ends each system prompt with its final answer rule, and it cuts a reply at its end marker. The replay gets both, as the app does.
- `AUTONOMY_REPLAY_REQUEST_FIELDS` adds body fields for each model, as JSON. The provider of the app turns reasoning off for autonomous speech, for example `{"gpt-6-luna":{"reasoningEffort":"none"}}`.
- The replay answers each tool call with a fixed text. No tool runs, so a replay changes no memory and no mission.
- `AUTONOMY_REPLAY_MAX_OUTPUT_TOKENS` limits the output of one model request. The app sets no limit, so leave it empty to measure the app. Set it when a model does not stop: one such line cost 129,000 output tokens and about 10 minutes on 2026-11-15.

The request start holds the character and the memory index of the owner. Keep it on the device, like the frames.

These parts of a request of the app are not in a replay: the summary of a long history, runtime contexts, and stickers.

## The cast of a recording

A line names a character only when the cast of the scene holds it. A recording can start after the screen that shows the names, for example a loading screen. Then write the names into `cast.txt` in the recording folder:

```text
The owner plays Ambessa. Allies: Caitlyn, Twitch, Karma. Opponents: Leona, Rakan.
```

The replay starts with this cast, and the judge checks the names of each line against it. `AUTONOMY_REPLAY_CAST=off` runs without the file.

## Labels for the gate trace

A recording with `labels.json` gets a score. A recording without it gets the pass rates only.

```json
{ "events": [{ "at": 32, "type": "kill", "important": true }] }
```

`at` is the time in seconds from the start of the recording. `important` marks a moment that a friend beside the owner speaks about.

The trace saves each look to `gate-trace.json` in the recording folder. A second run asks the model only for the missing looks. A change of the gate question starts the file again.

## Metrics

| Metric | Meaning |
| --- | --- |
| `turnsPerMinute`, `silenceShare` | How often the character tries to talk, and how often it stays quiet. |
| `firstTextMsMedian`, `firstTextMsSlow` | The time from the start of a request to the first text of a line: the median, and the time that 9 of 10 lines stay under. |
| `distinct2`, `typeEntropy` | The variety of the phrases and of the speech types. |
| `topicSimilarity` | The similarity of consecutive lines. Too high means a stuck topic, too low a jump without a link. |
| `repeatShare` | The share of lines that are close to one of the three lines before them. |
| `imagesPerHour`, `inputTokens`, `outputTokens`, `cachedTokens`, `cacheShare` | What the frames cost in images and tokens. Prices are left out. |
| `inputTokensPerLine`, `outputTokensPerLine` | The tokens of all turns for each spoken line. Silent turns count as cost of the lines. |
| `lineCharsMedian`, `lineCharsMax` | The length of a line in characters. A longest line of thousands means that the model did not stop. Its speech holds every later turn of the replay. |
| `cutShare` | The share of turns where the model wrote on after the end marker of its reply. The chat runtime dropped that text. |
| `missingEndShare` | The share of lines without an end marker. What the model writes after such a line reaches the speech. |
| `scoreShare` | The share of lines that say a score. A high share means that the character reads the scoreboard aloud. |
| `namedShare`, `wrongNameShare` | The share of judged lines that name a character, a skill, or an item, and the share with a wrong name. The judge is a model, so check the lines when a cast was wrong. |
| `requestsPerTurn`, `toolCalls` | The model requests for each turn. A tool call adds a request before the line. |
| `groundedShare`, `contradictionShare` | The share of lines that the judge found grounded in the screen, and the share that contradict the timeline. |
| `passesPerMinute`, `linesPerMinute` (gate) | How often the gate passes, and the lines that a gap of 6 seconds between lines leaves. |
| `recall`, `precision`, `onAnyEvent` (gate) | The share of important events that a pass caught, the share of passes at an important event, and the share at any labeled event. |

## Layout

| Path | Content |
| --- | --- |
| `src/recording.ts` | Reads the recordings that the screen recorder wrote. |
| `src/import-video.ts`, `src/bin/import-video.ts` | Turns a video into a recording with ffmpeg. |
| `src/replay.ts` | Replays one recording. It needs no network, and the tests give it a fake model. |
| `src/app-speaker.ts` | Speaks each turn through the chat runtime of `@proj-airi/core-agent`. |
| `src/request-start.ts` | Reads the request start that the app wrote. |
| `src/chat.ts` | The speaking model as a provider of the app, the session header of OpenCode Go, and the call of the judge. |
| `src/contact-sheet.ts` | Draws a contact sheet and scales frames with `@napi-rs/image`, in the sizes of the app. |
| `src/judge.ts` | The judge messages, and the reading of its JSON answer. |
| `src/metrics.ts` | The metrics of one replay. |
| `src/gate.ts` | The gate trace, its saved looks, the labels, and the score. |
| `evals/replay.eval.ts` | The replay task. Each recording runs once for each model and frame policy. |
| `evals/gate.eval.ts` | The gate trace task. Each recording runs once. |

## When to use it

- Use the replay before you change the order of a request, a frame policy, the detector thresholds, the commentary pace, or the default speaking model. Compare the metrics before and after the change on the same recording.
- Use the gate trace before you change the question or the threshold of the screen gate.

## When not to use it

- Do not use it as a unit test. It calls paid models, and it sends the recorded frames to the provider. `pnpm -F @proj-airi/evals-autonomy-replay test:run` runs the tests without network.
- Do not use it on a recording that holds private screens. The exclusion list of the app applies to recordings, but check the frames before a run.
- Do not commit a recording, a request start, or a report. They hold screens and the character of the owner.
