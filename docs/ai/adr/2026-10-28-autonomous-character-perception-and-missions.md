# Autonomous character: perception, speech pressure, and missions

Status: proposed

## Context

AIRI speaks only after an owner message or a module event. The owner wants a character that behaves on its own, as Neuro-sama does.
The owner has four requirements:

1. The character starts conversation without an owner message.
2. The character talks while it perceives the PC screen.
3. The character carries out tasks that the owner gives, for example game commentary and reminders.
4. The VRM model moves in natural, generated motions, not only an idle loop.

The owner withdrew one earlier requirement for now: lip sync with the TTS speech. The code has `useVRMLipSync`. Nobody has verified it.

### Findings from earlier trials

The owner tried a first design and found three faults. The causes below are hypotheses. Replay evaluation tests them.

- **The character talks about the screen without end.** The screen description is a "latest state" in every prompt. The model reacts to the most visible fact in the prompt.
- **A two-step LLM gives fixed reactions.** The first LLM picks a short behavior label from the owner message only. It has no state over time, so its labels converge to a few values.
- **Commentary is shallow.** A vision model turns each image into text. The chat model reads only the text, so motion and history are lost.

### Current code

- `notifyConversation` in `packages/stage-ui/src/stores/chat.ts` starts a turn without an owner message. The model speaks or stays silent. A silent notice leaves no history.
- The screen pipeline is `devtools/vision.vue`, then the vision model, then text context. A chat model reads an image itself when its catalog declares image input (`use-chat-vision.ts`).
- The character notebook holds tasks with `dueAt`, and the orchestrator sends a `spark:notify` for each due task. No tool lets the model create a task.
- The VRM has one animation, `idle_loop.vrma`, and expression changes. The loader and the `AnimationMixer` already exist.

## Decision

AIRI gets a perception layer, a speech decision layer, a mission layer, and a motion layer. The brain (requirements 1 to 3) and the body (requirement 4) can ship independently.
All features are off by default and apply to `apps/stage-tamagotchi` only.

### Principles

- Silence is the default. The character speaks when an event or an inner drive passes a threshold.
- The model that speaks sees the pixels. No step turns an image into text for the speaking model.
- Text carries the past. Images stay out of history, and a timeline of short notes stays in.
- Code owns variety. State and random choice give variety. A second LLM step does not.
- An owner instruction becomes an explicit mission. Code guarantees its time and its end.
- Capture is free and local. Only the images that go to the model cost money, so a budget limits them.
- The tool does not know any game. Genre-specific logic is not part of the code.

### Speaking model

- The speaking model is a chat model that accepts image input and returns text.
- A realtime model that answers with audio, such as Gemini Live, is out of scope.
- The owner chooses the model later. The design does not depend on one provider.
- The vision module stays as a fallback for chat models without image input. In that case the quality of commentary is lower.

### Perception

- Capture runs on the PC and costs nothing. A ring buffer holds frames at up to 2 frames per second for the last 60 seconds. It lives in memory only.
- Detectors run in code without a model call. They report a screen change, a motion amount, a loud sound, an app switch, and a long still period.
- No detector knows a game. Each detector event has a salience value.
- The buffer is not part of the prompt. A frame reaches the model only in a decision turn.

### Image budget

- The owner sets a budget in images per hour. The default is low.
- The budget counts every image that goes to the model.
- When the budget runs low, code lengthens the time between decision turns. When the budget is empty, no image goes out until the next hour.
- Settings show the images sent in the current hour.

### Speech pressure

- An event adds pressure by its salience. Pressure decays with time. A long silence adds a boredom term.
- Salience counts squared. Many small screen changes then add less pressure than one large change.
- Each mode has a base threshold. Code draws a random jitter for it once in each cycle between turns, so the gaps between turns vary.
- A refractory period follows each turn. A choice to stay silent lowers the pressure only in part.
- A gate stops a turn when the owner types or speaks, when speech plays, or when a turn runs. Owner input always wins.
- If a salient event happens between a decision and the playback, code drops the stale speech.
- The owner sets the base interval, the quiet hours, and the daily budget. The default is conservative.

### Decision turn

- Code calls the speaking model when pressure passes the threshold.
- The request holds new frames, the timeline, the time since the last speech, and a hint of the inner state.
- Frames are the ones that changed most since the last turn, not frames at equal spacing. The newest frame has full size. Older frames have a reduced size.
- Each frame goes to the model once. The timeline carries what older frames showed. This keeps the cost of one turn near the cost of its new frames.
- After an event, the request can include frames from before the event. A late reaction then still sees the cause.
- Images are part of this request only. History keeps the speech text and the timeline notes.
- The model speaks, stays silent, or writes a timeline note with the `noteTimeline` tool.

### Timeline

- The timeline is a list of short notes with times.
- Code writes app switches, owner speech, and mission starts. The model writes what it sees, for example "the boss fight started".
- Old notes are summarized so that the list stays short.
- The timeline is the only history of what happened on screen.

### Real-time games

- A model call and the speech playback take several seconds. The owner accepts this delay.
- Commentary therefore has two styles. After an event, the character reacts with frames from before the event. In between, it gives periodic commentary.
- The stale speech rule keeps a late line from playing after a newer event.
- The owner describes the game in the free text of the mission. The code has no game profile.

### Inner state and variety

- Inner state has energy, mood, boredom, curiosity, and a record of recent speech. Code updates it from time and events.
- A speech type is one of: react, joke, ask, recall a memory, think aloud, or watch quietly. Code draws the type by weight.
- A recently used type has a lower weight.
- Code passes the drawn type as a light hint in the same call. In a set share of turns, code passes no hint.
- The request holds the recent speech of the character, so the model avoids the same opening and structure.
- The design adds no second LLM step.

### Missions

An owner instruction becomes a mission. The model creates it with a tool. The owner sees all missions in Settings and can stop each one.

| Kind | Example | Behavior |
| --- | --- | --- |
| `reminder` | "Tell me at 18:00 that it is medicine time." | Code checks the clock. The character must speak. After a closed app, the next start reports the missed reminder. |
| `commentary` | "Comment on this game." | Perception becomes more sensitive, and the speech budget grows. The mission ends when the target window closes or the owner stops it. |
| `watch` | "Tell me when the download ends." | The mission registers a condition in the detectors and notifies when it holds. |

- A notice gets a `mustSpeak` option. Today a notice stays silent when the model gives no visible reply, so it cannot carry a reminder.
- Missions are stored on the device. The renderer leader checks the clock.

### Body: motion

The owner uses VRM models from outside sources. Their bones and expressions differ.

- At load, code reads which humanoid bones and expressions the model has.
- A clip or marker that needs a missing part is skipped. A missing feature turns off without an error.
- A `.vrma` clip uses normalized humanoid bones, so one clip fits many models.

Three layers stack. The team builds them in this order.

1. **Library.** A set of `.vrma` clips plays when the model writes a `<|MOTION:name|>` marker. Clips cover gestures such as a wave, a nod, a shrug, and a laugh.
2. **Speech-driven procedure.** The audio amplitude drives head nods and upper-body sway.
3. **Generated motion.** A tool turns text into a `.vrma` clip, and the library caches the result.

- Motion plays on an upper-body layer of the `AnimationMixer` with a crossfade of 0.2 to 0.4 seconds. The idle loop continues.
- Expressions are a separate layer.
- Generation is not a per-utterance step. It takes seconds to minutes. A request without a library match plays the nearest clip and queues a generation for later use.
- The owner allows any motion source. A community tool named Text-To-VRMA exists. This ADR did not verify its license or quality. Use it first offline, to build the library.

### Privacy

The speaking model is a cloud model. Frames leave the PC, so these rules are mandatory in the first release:

- Screen perception is opt-in. Settings state that the app sends frames to the selected cloud provider.
- An indicator shows while perception runs. One click pauses it.
- An exclusion list names apps and window titles. A match skips the frame. The default list holds password managers, banks, and messengers.
- Perception pauses on suspend, on lock screen, and when the source disappears.
- The app stores no frame on disk.

## Implementation boundaries

- `packages/core-agent` owns the portable policy: pressure, thresholds, gates, budget, speech types, mission rules, and the timeline. These are pure functions with a clock and a random source as inputs.
- `packages/stage-shared` owns frame comparison and the detectors. It has no Vue dependency.
- `packages/stage-ui` owns the stores, the ring buffer, the decision turn, the mission store, and the tools.
- `packages/stage-ui-three` owns the motion layers and the marker playback.
- `apps/stage-tamagotchi/src/main` owns the idle time and the window list. Eventa contracts live in `apps/stage-tamagotchi/src/shared`.
- Strings live in `packages/i18n`. Only the English locale and the locale of the author change.
- The renderer leader runs perception, pressure, and missions. Other windows read state.

## Relation to ADR 2026-10-10

[ADR 2026-10-10](./2026-10-10-skills-automations-and-memory.md) describes auto-run recipes. The code on `main` has no automation and no `armRecipe` tool.
A `reminder` mission matches a `modelTimed` run in that ADR. A `commentary` mission has no match, because it is a foreground mode with a voice.
Names such as `trigger`, `condition`, and `cooldown` follow that ADR. Check upstream work before each step that touches missions.

## Validation

Opinion alone cannot judge behavior. Replay evaluation compares methods on the same input.

- Steps 0 to 2 use synthetic event streams with a fake clock. Step 3 adds a recorder that saves timed frames and audio, and a replay that runs perception and decision from the recording.
- Metrics: turns per minute, the share of silence, repeated openings and structure (`distinct-n`), the entropy of the speech types, and images sent per hour.
- A judge model checks whether a speech refers to a real event in its window. Another check finds contradictions with the timeline.
- Evaluations follow the form of `evals/asr-rewrite` and `evals/tts-speech-formula`.
- Deterministic tests with a fake clock and a fixed random source cover pressure, gates, the budget, speech types, and missions.
- Live checks with a real cloud model and a real screen are not part of CI. Record them in the PR.

## Non-goals

- Lip sync work. The owner withdrew it for now.
- A realtime streaming API for audio and video. The first design uses decision turns.
- A local vision model. The first release supports cloud providers only.
- Screen perception in `stage-web` and in `apps/stage-tamagotchi-kirie`.
- Control of the PC from the screen content. Computer use has its own tools.
- Storage of frames or of a long screen history.
- Game-specific detectors or profiles.

## Steps

The order follows dependencies. Each step uses the parts of the earlier steps.

| Step | Content | State |
| --- | --- | --- |
| 0 | Policy core without the screen: pressure, gates, inner state, and speech types in `core-agent`. Evaluation harness with synthetic events. | Done |
| 1 | Mission base and `reminder`: the `mustSpeak` notice, storage, the mission list, and the tools. | To do |
| 2 | Autonomous talk without the screen: connect the policy core to `notifyConversation` with silence and timer triggers. Measure variety. | To do |
| 3 | Perception: local capture, ring buffer, detectors, image budget, recorder, decision turn with images, timeline, and the `commentary` and `watch` missions. | To do |
| 4 | Motion: model capability check, library, markers, upper-body layer, and speech-driven procedure. | To do |
| 5 | Generated motion, topics from memory, and polish. | To do |

Step 4 does not depend on steps 0 to 3. It comes after them so that the speech output format changes only once.

## Open work

- Choose the image-capable speaking model, and set the default image budget.
- Check upstream issues and pull requests for automation work before step 1.
- Choose the default exclusion list with the owner.
- Decide whether a realtime API enters a later ADR.
