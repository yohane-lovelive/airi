# Autonomous character: perception, speech pressure, and missions

Status: proposed

## Context

AIRI speaks only after an owner message or a module event. The owner wants a character that behaves on its own, as Neuro-sama does.
The owner has four requirements:

1. The character starts conversation without an owner message.
2. The character talks while it perceives the PC screen.
3. The character carries out missions that the owner gives, for example reminders, game commentary, watches, and small talk.
4. The VRM model moves in natural motions, not only an idle loop.

The owner wants the same character on every device. On a PC, the desktop app and the web app behave the same. On a phone, the web app works without screen perception.
The owner withdrew one earlier requirement for now: lip sync with the TTS speech. The code has `useVRMLipSync`. Nobody has verified it.

### Findings from earlier trials

The owner tried a first design and found five faults. The causes below are hypotheses. Replay evaluation tests them.

- **The character talks about the screen without end.** The screen description is a "latest state" in every prompt. The model reacts to the most visible fact in the prompt.
- **Behavior becomes chaotic.** Each mission added its own system prompt, and the model decided what to do from the full prompt. The prompt held too much information.
- **A two-step LLM gives fixed reactions.** The first LLM picks a short behavior label from the owner message only. It has no state over time, so its labels converge to a few values.
- **Commentary is shallow.** A vision model turns each image into text. The chat model reads only the text, so motion and history are lost.
- **Small talk sticks to one topic.** A separate LLM call made topics, and code gave one chosen topic in each turn. The model stayed on the topic, and it did not move to related topics.

### Current code

- `notifyConversation` in `packages/stage-ui/src/stores/chat.ts` starts a turn without an owner message. The model speaks or stays silent. History keeps a silent notice, but no reply.
- The screen pipeline is `devtools/vision.vue`, then the vision model, then text context. A chat model reads an image itself when its catalog declares image input (`use-chat-vision.ts`).
- The character notebook holds tasks with `dueAt` in memory only. The orchestrator sends a `spark:notify` for each due task. No tool lets the model create a task.
- Recipes and long-term memory are in IndexedDB, one record for each item. They stay on the device. Chats and character cards sync to the server.
- Each run puts the full memory index into the prompt. A memory is saved only when the model calls `builtIn_writeMemory`. `compactConversationEntries` exists, but no caller uses it.
- `stage-web` elects a renderer leader with the same synced Pinia runtime as the desktop app.
- The VRM has one animation, `idle_loop.vrma`, expression changes, blinks, and eye motions. The loader and the `AnimationMixer` already exist.

## Decision

AIRI gets a perception layer, a speech decision layer, a mission layer, and a motion layer. The brain (requirements 1 to 3) and the body (requirement 4) can ship independently.
All features are off by default. They apply to `apps/stage-tamagotchi` and `apps/stage-web`.

### Principles

- Silence is the default. The character speaks when an event or an inner drive passes a threshold.
- Code owns the state and the rhythm. The model owns the words. The model can write to a small, bounded part of the state with tools.
- Each part of the prompt has a size limit. The model reads more with tools when it needs more.
- The model that speaks sees the pixels. No step turns an image into text for the speaking model.
- Text carries the past. Images stay out of history, and a timeline of short notes stays in.
- Code owns variety. State and random choice give variety. A second LLM step does not.
- An owner instruction becomes a mission. Code guarantees its time and its end.
- Capture is free and local. Only the images that go to the model cost money, so a budget limits them.
- The code does not know any game. Genre-specific logic is not part of the code.
- Every device runs the same brain. The capabilities of the device decide which features run.

### Devices

| Device | Brain, missions, motion | Screen perception |
| --- | --- | --- |
| Desktop app | Yes | Yes. Capture starts without a prompt. The app knows the window list and the system idle time. |
| Web app on a PC | Yes | Yes, with limits. See below. |
| Web app on a phone | Yes | No. Code detects that the browser cannot capture the screen and turns perception off. |

Two adapters hide the differences: a screen source and a presence source. The presence source reports the idle time and the window list.
The web app has these limits:

- `getDisplayMedia` asks the owner to choose a share after each page load. The capture stops when the tab closes.
- The browser does not tell the window list or the app names. App switch detection and the exclusion list do not work on a full-screen share.
- The Idle Detection API gives the idle time in Chromium browsers, after a permission prompt.
- A hidden tab slows down its timers. Timers run in a worker to avoid this.
- A closed tab cannot speak. The next page load reports the missed reminders.

`apps/stage-pocket` and `apps/stage-tamagotchi-kirie` are not targets of this ADR.

The owner usually uses one device at a time. When two devices are open, one device holds the floor:

- The device that connected first holds the floor until it disconnects. Then the next device takes it.
- Only the device that holds the floor runs autonomous speech and missions.
- A reply to an owner message plays on the device where the owner sent it.
- The floor needs a presence record on the server, so the memory ADR defines it. Until then, the owner opens one device at a time.

### Speaking model

- The speaking model is a chat model that accepts image input and returns text.
- The default is `deepseek-v4.1-flash` from OpenCode Go. Its public model list declared image input and tool calls on 2026-10-30.
- Commentary uses the `low` reasoning effort, because reasoning adds delay.
- The owner can change the model at any time. Memory is text, so a change of model keeps all memories.
- A model without image input uses the vision module as a fallback. In that case the quality of commentary is lower.
- A model without tool calls cannot create missions, write timeline notes, or answer watch checks.
- The web app needs a proxy for OpenCode Go, because of CORS. The dev server has one. A production build needs its own solution.
- A realtime model that answers with audio, such as Gemini Live, is out of scope.

### State ownership

Code keeps the state. The model decides the words in one moment.

| Decision | Owner |
| --- | --- |
| When to speak, and when to stay silent for a long time | Code: pressure, gates, refractory time |
| Which mission runs, and when it starts and ends | Code: mission states |
| The mode, for example idle or commentary | Code |
| Whether to interrupt, and whether to drop stale speech | Code |
| The image count and the daily turn count | Code: budgets |
| The candidate speech type | Code: weighted draw |
| What to say, and whether to stay silent in this turn | Model |
| What it saw on the screen | Model: timeline notes with a tool |
| Whether a watch condition holds | Model: a yes or no answer with a tool |
| What it wants to do later | Model: intentions with a tool, inside limits |
| How much to talk, for a time | Owner: words in chat, which a tool turns into settings |

- An intention is a short note, for example "ask the owner about the trip later". Code limits the count and gives each one an expiry time.
- Code turns an intention into pressure and into a topic seed. The model can also move its mood by a small, limited amount.
- The renderer leader is the only writer of this state. Other windows read it.

### Owner control

The owner can change the talk level with words, for example "be quiet for 30 minutes" or "you can talk more".

- A tool turns the request into a setting change. Code checks each value and keeps it inside set limits.
- Changes are temporary or permanent. A temporary change has an end time, for example a quiet period.
- Only a turn that answers an owner message can use this tool.
- Implicit feedback also changes the level. When the owner does not react to autonomous speech, the interval grows in small steps. A reaction from the owner returns it.
- The inspector and Settings show the current changes. The owner can reset them.

### Prompt budget

Code builds each request in the same shape. Each part has a limit.

| Part | Limit | Note |
| --- | --- | --- |
| Persona (system prompt) | Fixed | It does not change, so the provider cache applies. |
| Owner profile summary | About 300 tokens | |
| Recalled memories | Top 5, about 500 tokens | Never the full memory index |
| Situation block | About 300 tokens | Mode, time since the last speech, speech type hint, recent speech |
| Timeline | Last 10 notes | |
| Mission instruction | One running mission, 500 characters at most | |
| Conversation history | A summary keeps it under a limit | |
| Images | Set by the frame policy | |

- If a request goes over its limit, code drops the part with the lowest priority first.
- The model reads details with tools. Code does not put them into the prompt in advance.
- IO traces record the size of each part, so a trace shows when a prompt holds too much.

### Perception

- Capture runs on the device and costs nothing. A ring buffer holds frames at up to 2 frames per second for the last 60 seconds. It lives in memory only.
- A mission with a target window captures that window only. If the target window is not in front, perception pauses.
- On the web, a share of one window or one tab is the recommended choice.
- Detectors run in code without a model call. They report a screen change, a motion amount, a loud sound, an app switch, and a long still period.
- No detector knows a game. Each detector event has a salience value.
- The buffer is not part of the prompt. A frame reaches the model only in a decision turn.

These rules keep menus, transitions, and desktop switches from counting as large events:

- **Settle, then compare.** After a large change, the detector waits until the screen is still for 0.5 to 1 second. Then it compares the new still screen with the last still screen.
- **Familiar screens.** The detector keeps a small hash of each recent still screen. A screen that is near a recent one gets a low salience. Menus, maps, and the desktop become familiar.
- **Baseline for each app.** The detector measures change against the usual change of the current app, not against a fixed value.
- **App switch dwell.** An app switch counts only after the owner stays in the new app for some seconds. A switch to the desktop or a file manager gets a low salience.
- **Labels from the model (later).** The model can label a screen in a timeline note, for example "menu". The detector then gives that screen a low salience.

### Frame policy

The frame policy chooses which frames go to the model in each turn. It is a replaceable part. A developer setting selects it, and replay evaluation chooses the default.

| Policy | Frames |
| --- | --- |
| `fresh-keyframes` | The frames that changed most since the last turn, and the frames before an event. Only the newest frame has full size. |
| `contact-sheet` | Reduced frames with times, placed as tiles in one image. The budget counts one image. |
| `scene-anchor` | One anchor frame for each scene, in a fixed part of the prompt. New frames follow it. |

- Policies can combine, for example `scene-anchor` with `contact-sheet`.
- `scene-anchor` needs the provider cache. The cache read price of the default model is about 1/50 of the input price. Nobody has measured whether the cache applies to images.
- A scene state note carries what frames cannot carry. The model updates it, for example the game, the place, the goal, and the health of the player character.

### Image budget

- The owner sets a budget in images per hour. The default is low.
- The budget counts every image that goes to the model, watch checks included.
- When the budget runs low, code lengthens the time between decision turns. When the budget is empty, no image goes out until the next hour.
- A running commentary mission raises the budget.
- Settings show the images sent in the current hour.

### Usage by purpose

Each model call records its purpose. Settings and the inspector show the usage of each purpose.

- The purposes are owner replies, autonomous turns, commentary, watch checks, topic seeds, memory work, and motion generation.
- For each purpose, the record holds the calls, the input tokens, the cached tokens, the output tokens, the images, and the cost.
- The cost uses the model price at the time of the call. The peak hours of a provider then show as a higher cost.
- The view shows the current day and the last 30 days.

### Inspector

The inspector is a panel on the main stage screen. A developer setting turns it on. It shows why the character speaks or stays silent.

- It shows the drive, the threshold, and the inner state as a graph over time.
- It shows the current gate reason, the mode, the running missions, the intentions, and the topic heat.
- It shows the timeline, the scene state, the frames of the last turn, and the usage by purpose.
- It shows the active owner changes, and it can reset them.
- The panel reads state only. It does not change the policy.

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
- The request follows the prompt budget. It holds the frames of the frame policy, the timeline, the scene state, and a hint of the inner state.
- After an event, the request can include frames from before the event. A late reaction then still sees the cause.
- Images are part of this request only. History keeps the speech text and the timeline notes.
- The model speaks or stays silent. With tools, it can also write a timeline note, update the scene state, or write an intention.

### Commentary

The pace of commentary follows the scene, not a fixed interval.

- Boredom grows faster in an active scene and slower in a calm scene. A calm scene can stay silent for a long time.
- One commentary line is short, about one sentence. A long line cannot keep up with the next event.
- When a large event happens, code starts the next model call at once. The new line can then replace the current line with less delay.

A new event can interrupt the current speech. These rules keep the speech coherent:

- An interruption needs a very large event. Its salience must also be clearly more than the salience that started the current speech.
- A normal interruption lets the current sentence end and drops the rest. Only the largest events cut the speech at once.
- After an interruption, no other interruption happens for about 15 seconds.
- Owner speech always stops the character. The character never interrupts the owner.
- The timeline records the interrupted line, so the character can return to it later.

### Timeline and scene state

- The timeline is a list of short notes with times.
- Code writes app switches, owner speech, mission starts, and interruptions. The model writes what it sees, for example "the boss fight started".
- Old notes are summarized so that the list stays short.
- The timeline is the only history of what happened on screen.
- The scene state is one short text that the model updates. It describes the current scene, not its history.

### Inner state and variety

- Inner state has energy, mood, boredom, curiosity, intentions, and a record of recent speech. Code updates it from time, events, and tools.
- A speech type is one of: react, joke, ask, recall a memory, think aloud, or watch quietly. Code draws the type by weight.
- A recently used type has a lower weight.
- Code passes the drawn type as a light hint in the same call. In a set share of turns, code passes no hint. The model can ignore a hint.
- The request holds the recent speech of the character, so the model avoids the same opening and structure.
- The design adds no second LLM step.

### Missions

A mission has three layers.

| Layer | Content | Author | Growth |
| --- | --- | --- | --- |
| Building blocks (code) | Triggers, lenses, speech styles, end rules, and budgets | Developers | Rare. Only a new kind of trigger needs code. |
| Template (data) | A combination of building blocks and a short instruction | The owner. The model can propose one, and the owner approves it. | Grows with use |
| Instance | A template with values, for example a time or a target window | The model, from the words of the owner, with a tool | One for each request. It ends. |

The building blocks:

- **Trigger:** a time, a screen condition, an app start, or a request from the owner.
- **Lens:** the target window, a region of interest, and what to look for.
- **Speech style:** the mode, `mustSpeak`, and the length of one line.
- **End rule:** after one run, when the target window closes, when a condition holds, or at a time limit.

A template is a recipe with a `mission` block. It uses the keywords, the approval, the proposals, the storage, and the Settings page of recipes.
A recipe runs in the background without a voice. A mission runs in the foreground with a voice, so it has its own run path.

The built-in templates:

| Template | Trigger | Lens | Speech style | End rule |
| --- | --- | --- | --- | --- |
| `reminder` | A time | None | `mustSpeak` | After one run |
| `commentary` | Owner request | Target window | Commentary mode | When the target window closes |
| `watch` | A screen condition | Target window and region | `mustSpeak` | When the condition holds |
| `small-talk` | Owner request, or a quiet owner nearby | None | Idle mode, more often | When the owner leaves, says stop, or at a time limit |
| `greeting` | App start | None | Normal | After one run |
| `welcome-back` | Owner input after time away | None | Normal | After one run |

The last two templates give a daily rhythm. These rules complete it:

- The greeting depends on the local time and on the time since the last talk. A first talk after many days gets a different greeting.
- The time of day changes the inner state. Energy is lower late at night, and the speech hints change with the time.
- The desktop app reads time away from the system idle time. The web app uses the Idle Detection API, or page focus when the API is not available.

- Code checks each value that the model gives. The model can only create and stop instances.
- A mission instruction has 500 characters at most. It never replaces the persona.
- One foreground mission runs at a time, for example commentary or small talk. Background missions, such as reminders and watches, enter the prompt only when they fire.
- A notice gets a `mustSpeak` option. Today a notice stays silent when the model gives no visible reply, so it cannot carry a reminder.
- A watch uses a check turn, not a speech turn. A change in the region, or a slow timer, starts the check.
- In a check turn, the model gets a small crop and answers with a tool. Only a "yes" starts a `mustSpeak` notice.
- IndexedDB keeps the instances on the device, one record for each instance, in the shape of the recipe records.
- The renderer leader checks the clock.

#### Mission tools

- `builtIn_startMission` takes a template name and its values. `builtIn_listMissions` lists the instances. `builtIn_stopMission` stops one instance.
- The tool description lists the templates and their values in short form, inside the prompt budget.
- Each template has its own value schema. If a value is wrong, the tool returns the reason, and the model can try again.
- A new template needs no new tool.

#### Reminder rules

- The model gives the first run in one of two forms:
  - `at`: a local clock time as an ISO string, for example `2026-10-31T18:00`.
  - `after`: minutes from now, for example "in 10 minutes".
- Code counts an `after` start from the real time, to the second. The model sees message times without seconds. So a clock time that the model counts itself is up to one minute early, or already in the past.
- The tool description tells the model to use `after` for any time from now, and `at` only for a clock time that the owner names.
- Code refuses a time in the past and a time too far ahead. A clock time in the current minute is still valid.
- A reminder runs once, or it repeats in one of these ways:
  - Daily, on weekdays, or weekly on chosen days, at one time of day.
  - At an interval from the first run, from 15 minutes to 24 hours. A shorter interval makes the character talk too often.
- After each run, code sets the next time of a repeated reminder. The owner stops it in the mission list or in chat.
- The owner asks for a repeated reminder in chat, so it needs no approval. This differs from the rule for repeated recipes in ADR 2026-10-10.
- A reminder speaks also in quiet hours and in a temporary quiet period. The owner chose the time, so the time wins.

If the model gives no visible reply to a `mustSpeak` notice, code makes sure that the owner still gets the reminder:

1. Code sends the notice again one time.
2. If the second reply is also empty, the character speaks a fixed text, for example "Reminder: medicine time".
3. If the model call fails, code skips the second try and speaks the fixed text at once.
4. If speech playback fails, code shows an operating system notification. The web app needs the notification permission for this.

After a closed app, the next start reports the missed reminders:

- A reminder that was missed by less than the age limit gets a notice. The default limit is 24 hours, and Settings can change it.
- An older missed reminder only gets the state "missed" in the mission list.
- All missed reminders of one start go into one notice, so the character does not speak many times after the start.

### Small talk

Topics flow. Code does not assign one topic for the whole talk.

- **Topic seeds.** A pool collects seeds from memories, owner interests, recent screen events, the season, intentions, and the interests of the character. A cheap background call can add seeds.
- **Choices in each turn.** The model can continue the current thread, move to a related topic from the last line, or take a new seed. Code offers two or three seeds.
- **Novelty.** A seed near a recent topic gets a lower weight.
- **Heat.** Each thread has a heat that falls with each turn. It falls faster when the owner reacts little, for example with short replies, no reply, or no questions back.
- **End of a thread.** A cold thread is no longer a choice. Code then offers related topics and new seeds.
- **Topic history.** Each turn records a short topic label and its embedding. The pool avoids the topics of the same day and of recent days.

### Body: motion

The owner uses VRM models from outside sources. Their bones and expressions differ.

- At load, code reads which humanoid bones and expressions the model has.
- A clip or marker that needs a missing part is skipped. A missing feature turns off without an error.
- A `.vrma` clip uses normalized humanoid bones, so one clip fits many models.

MMD models use the same `.vrma` clips. The library stores only `.vrma` data, and code retargets a clip when an MMD model plays it:

- Each VRM bone gets a standard MMD bone, for example `leftUpperArm` gets `左腕`. A bone that the model lacks passes its rotation to its children.
- VRM rotations are relative to a T-pose. Code corrects them for the MMD rest pose, which is an A-pose for most models.
- The hips translation moves `センター`, scaled by the ratio of hip heights.
- Code also writes the positions of the IK bones, for example `左足ＩＫ`, from the retargeted pose. IK stays on, so the clip blends with VMD motions that drive the legs by IK.
- Until the owner chooses a VMD idle, an MMD model plays the VRM idle loop.
- `packages/stage-ui-mmd/src/utils/vrma-retarget.ts` owns the retarget. A generated clip goes through the same retarget.

Three layers stack. The team builds them in this order.

1. **Procedural layer.** Code moves the body without clips. It adds breath, small sway, and gaze with a delayed neck and head. The gaze moves away while the model thinks, and the speech amplitude drives nods. Blinks and eye motions exist.
2. **Library.** The model writes the existing `<|ACT|>` marker with an expression and a free-text motion, for example `<|ACT {"expression":"shy","motion":"scratch head shyly"}|>`. Code plays the nearest clip from the library.
3. **Generated motion.** Generation adds clips to the library over time.

The library:

- IndexedDB keeps one record for each clip. The record holds the `.vrma` data, a description, tags, and the body part (upper body or full body).
- The record also holds the duration, the source, the required bones, a use count, and the decision of the owner. The source is bundled, generated, or imported.
- At first, code matches the marker text against tags and descriptions. When the library grows, embeddings replace this match. The marker format stays the same.
- Motion plays on an upper-body layer of the `AnimationMixer` with a crossfade of 0.3 to 0.5 seconds. The idle loop continues.

Expressions and motions stay in sync:

- Expressions are a separate layer, but one marker drives both. The expression starts with the motion and ends with it.
- Each clip can have an expression track. If the marker has no expression, code uses the expression of the clip.
- If the marker has an expression and the clip has none, the expression from the marker plays for the duration of the clip.
- If the model has no matching expression, the motion plays alone.

Generation:

- Generation is never a step of each reply. A text-to-motion model takes seconds and gives frozen fingers, sliding feet, and travel of the hips.
- Generation starts in two cases. In the first case, the owner asks for a motion, for example "swing a sword". The character says a short line first, and the clip plays when it is ready.
- In the second case, no clip matches a marker. The nearest clip plays, and a generation goes into a queue for later use.
- The generator is an external service that the app calls over HTTP. The desktop app and the web app use the same service.
- Playback of a generated clip locks the lower body and limits the travel of the hips. It also sets a preset finger pose and smooths the rotations.
- The owner keeps or deletes each generated clip in Settings. A kept clip stays in the library.
- The owner allows any motion source. A community tool named Text-To-VRMA exists. This ADR did not verify its license or quality.

### Memory and devices

A separate ADR covers long-term memory and sync between devices. This ADR depends on it as follows:

- A device that connects later gets the same memories and conversations.
- The server keeps the presence record for the floor between devices.
- The `recall` speech type and the small-talk seeds read memories through one retrieval interface.
- Missions, intentions, and timeline notes are records that the sync design can carry. Frames never leave the device, except to the speaking model.
- The planned direction is a server as the source of truth. It uses PostgreSQL with VectorChord, which the backend stack already has, and EmbeddingGemma 2.

### Privacy

The speaking model is a cloud model. Frames leave the PC, so these rules are mandatory in the first release:

- Screen perception is opt-in. Settings state that the app sends frames to the selected cloud provider.
- An indicator shows while perception runs. One click pauses it.
- An exclusion list names apps and window titles. A match skips the frame. The default list holds password managers, banks, and messengers.
- On the web, the exclusion list cannot work on a full-screen share. Settings state this, and they recommend a share of one window or one tab.
- Perception pauses on suspend, on lock screen, and when the source disappears.
- The app stores no frame on disk. The evaluation recorder is the only exception.

The recorder obeys these rules:

- It is a developer tool. It runs only when the owner starts it, and an indicator shows while it runs.
- It saves each recording in one folder that Settings name. Settings can delete each recording.
- The exclusion list also applies to the recorder.
- Recordings never leave the device.

### Game audio (later)

Story games tell events with voice lines. A transcript of the game audio can enter the timeline, so commentary can follow the story.

- The transcript uses a local speech recognition model, because it runs for a long time.
- System audio can also hold the voices of friends in a Discord call. Their speech must not enter the timeline as game lines.
- The capture therefore takes only the audio of one process: the process that owns the target window.
- Windows supports the capture of one process, but Electron does not expose it. The desktop app needs a native module for it.
- Only the desktop app on Windows has game audio. The owner needs it only while the owner uses the PC.
- Participation in a Discord voice call is a future ADR. In a call, the bot receives one audio stream for each speaker, so the voices stay separate.

### Known risks

The owner accepts these risks for now. If a fault appears, a later change adds the listed fix.

| Risk | Reason to wait | Fix when needed |
| --- | --- | --- |
| The microphone hears the speech of the character, so the character stops itself or answers itself. | The owner uses headphones. | Echo cancellation, a match against the audio that plays, or a speaker check with `speaker-tracker`. |
| Text on the screen acts as an instruction to the model, for example "add a reminder". | No fault seen yet. | Limit tools by turn type. Screen-started turns cannot create missions or write memories. Mark screen text as untrusted data. |
| The character talks during a call or a meeting. | The owner plans to use AIRI in Discord calls, so a fixed mute rule does not fit. | A do-not-disturb rule that knows whether AIRI takes part in the call. |

## Implementation boundaries

- `packages/core-agent` owns the portable policy: pressure, thresholds, gates, budgets, speech types, intentions, mission rules, topic heat, and the timeline. These are pure functions with a clock and a random source as inputs.
- `packages/stage-shared` owns frame comparison, the detectors, and the frame policies. It has no Vue dependency.
- `packages/stage-ui` owns the stores, the ring buffer, the decision turn, the mission store, the tools, the adapter interfaces, the usage records, and the inspector.
- `packages/stage-ui-three` owns the motion layers, the library playback, and the marker playback.
- `apps/stage-tamagotchi/src/main` owns the idle time and the window list. Eventa contracts live in `apps/stage-tamagotchi/src/shared`.
- `apps/stage-web` owns the `getDisplayMedia` and Idle Detection adapters.
- Strings live in `packages/i18n`. Only the English locale and the locale of the author change.
- The renderer leader runs perception, pressure, and missions. Other windows read state.

## Relation to ADR 2026-10-10

[ADR 2026-10-10](./2026-10-10-skills-automations-and-memory.md) describes recipes and auto-run recipes. On 2026-10-30, upstream `main` had no automation code and no `builtIn_armRecipe` tool.

- A mission template is a recipe with a `mission` block. It uses the recipe storage in IndexedDB.
- A `reminder` matches a `modelTimed` run in that ADR. A `commentary` and a `small-talk` have no match, because they are foreground modes with a voice.
- Names such as `trigger`, `condition`, and `cooldown` follow that ADR.
- Check upstream work before each step that touches missions.

## Validation

Opinion alone cannot judge behavior. Replay evaluation compares methods on the same input.

- Steps 0 to 2 use synthetic event streams with a fake clock. Step 3 adds a recorder that saves timed frames and audio, and a replay that runs perception and decision from the recording.
- Metrics: turns per minute, the share of silence, repeated openings and structure (`distinct-n`), the entropy of the speech types, and images sent per hour.
- More metrics: the share of reminders that the character speaks on time, the interruptions per minute, and the topic similarity of consecutive turns.
- Topic similarity has a target range. A value that is too high means a stuck topic. A value that is too low means a jump without a link.
- The replay runs each frame policy on the same recording. It records the image count, the tokens, the cache share, and the cost.
- A judge model checks whether a speech refers to a real event in its window. Another check finds contradictions with the timeline.
- Evaluations follow the form of `evals/asr-rewrite` and `evals/tts-speech-formula`.
- Deterministic tests with a fake clock and a fixed random source cover pressure, gates, budgets, speech types, intentions, owner control, topic heat, and missions.
- Live checks with a real cloud model and a real screen are not part of CI. Record them in the PR.

## Non-goals

- Lip sync work. The owner withdrew it for now.
- A realtime streaming API for audio and video. The first design uses decision turns.
- A local vision model. The first release supports cloud providers only.
- Screen perception on phones, in `apps/stage-pocket`, and in `apps/stage-tamagotchi-kirie`.
- Control of the PC from the screen content. Computer use has its own tools.
- Storage of frames or of a long screen history.
- Game-specific detectors or profiles.
- Motion generation for each reply.
- Reactions to the chat of stream viewers. The current use is a personal desktop agent.
- Participation in Discord voice calls. A future ADR covers it.

## Steps

The order follows dependencies. Each step uses the parts of the earlier steps. Each step works in the desktop app and in the web app.

| Step | Content | State |
| --- | --- | --- |
| 0 | Policy core without the screen: pressure, gates, inner state, and speech types in `core-agent`. Evaluation harness with synthetic events. | Done |
| 1 | Mission base: the time trigger, the instance store, and the tools. Also the `mustSpeak` notice, the `reminder` template, and the mission list. | Done |
| 2 | Autonomous talk without the screen: connect the policy core to `notifyConversation`. Add the prompt budget, intentions, owner control, usage by purpose, and the inspector. | To do |
| 2b | Daily rhythm and small talk: templates as recipes, the `greeting`, `welcome-back`, and `small-talk` templates, topic seeds, and the time of day. Measure variety. | To do |
| 3 | Perception: the adapters, ring buffer, detectors, frame policies, image budget, recorder, replay, timeline, scene state, `commentary` with interruptions, and `watch`. | To do |
| 4 | Motion: the model capability check, the procedural layer, the library with `ACT` markers, expression sync, and the upper-body layer. | To do |
| 5 | Generated motion, game audio, recall from memory, and polish. Recall needs the memory ADR. | To do |

Step 4 does not depend on steps 0 to 3. It comes after them so that the speech output format changes only once.
The memory ADR has its own steps. They can run beside steps 1 to 4.

## Open work

- Agree on the step 0 defaults with the owner. They are about 15 minutes for idle talk, 45 seconds for commentary, and 200 turns each day.
- Set the default image budget.
- Choose the default exclusion list with the owner.
- Measure whether the OpenCode Go cache applies to images.
- Find a CORS solution for the production web build.
- Write the ADR for long-term memory and sync between devices. It also defines the floor between devices.
- Choose the native module for the capture of one process with the owner, before step 5.
- [The idea notes](../context/autonomy-ideas.md) keep the features that the owner held for later.
- Decide whether a realtime API enters a later ADR.
