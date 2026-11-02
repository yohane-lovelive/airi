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

Step 2-2 built intentions, owner control, and implicit feedback as follows.

- Intentions: at most 5 open ones. Each one stays 1 to 168 hours, 24 by default. Each one adds 0.2 drive, up to 0.4. The situation block lists them with their ids, and the model finishes one after it uses it. IndexedDB keeps them, like missions.
- Owner control: `quiet` stops autonomous speech for 1 to 720 minutes. `less` and `more` multiply the idle interval by 1.5 or 0.67 for a time. With 0 minutes, they change the interval in Settings. `normal` ends every change for a time. The device keeps the changes, so they last through a restart.
- The talk level tool refuses in a turn that does not answer an owner message. The tool list stays the same in each turn, so the tool checks the turn itself.
- Implicit feedback: each autonomous line without an owner message multiplies the idle interval by 1.3, up to 3 times the setting. It applies to idle talk only. The count lives in memory, so a restart returns the pace.
- Settings show the changes for a time and reset them. The inspector of step 2-3 shows the implicit feedback, because only the leader holds its count.
- The model does not move its mood with a tool yet. The effect is small, so it waits for a need.

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

Step 2-4 built the prompt budget as follows. It covers every chat request, not only autonomous turns.

- History summary: when more than 60 messages or about 40,000 characters follow the summary, the chat model of the session folds all but the last 20 messages into a new summary of 1,500 characters at most. Requests send the summary and the messages after it. The summary moves in large steps, so the cached prefix changes only every few dozen messages.
- The summary runs in the background after a send, as the `history-summary` usage purpose. Until it is ready, requests send the whole history. The chat view always shows every message.
- The session meta on the device keeps the summary and its last message. When that message is deleted, the summary no longer fits, and requests send the whole history until a new summary comes.
- Settings > Modules > Short-Term Memory turns the summary on or off, and shows and removes the summary of the open conversation. It is on by default.
- Memory: the index lists 50 entries at most, the card's own entries first, newest first. `builtIn_searchMemory` finds the others by shared character pairs, which also works for Japanese. Recall of the top 5 memories by meaning needs embeddings, so the memory ADR builds it.
- IO traces record the characters of the system prompt, the memory index, the summary, and the history, and the count of summarized messages.
- No owner profile exists yet, so it has no part. The timeline and the mission instruction come with their steps.

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

Step 3-1 built the screen source, the ring buffer, and the privacy rules as follows. No frame goes to the model yet.

- **Screen source.** Each app passes a `ScreenSource` to the perception runner. It starts a capture, and it can tell the window in front and a lock or sleep.
  - The desktop app captures the primary display without a prompt, through `electron-screen-capture`.
  - The main process reads the window in front with `get-windows` 9.3.0, through the eventa invoke `electronForegroundWindow`. Electron cannot tell it. Version 10 was too new for the `minimumReleaseAge` rule of the repository.
  - The web app uses `getDisplayMedia`. A start needs a click of the owner after each page load. The picker offers a window first, and it leaves out the AIRI tab. A phone browser is not supported.
- **Ring buffer.** The renderer leader takes 2 frames each second and keeps the last 60 seconds, 120 frames at most, in memory only.
  - Each frame is a JPEG of 1280 pixels at most on its long side, and a 64 by 36 grayscale thumbnail for the detectors. A worker encodes the frames.
  - A pause, a lock, a leader change, or an end of the share drops the frames.
- **Privacy.**
  - Settings > Modules > Screen perception turns it on. It is off by default.
  - An eye button shows while perception is on, in the controls island of the desktop app and in the chat header. One click pauses or resumes it, and the pause holds after a restart.
  - The exclusion list matches the app name, the app file name, or the window title of the window in front. A match skips the frame before it is taken. An English entry matches whole words only.
  - The default list holds password managers, messengers, and banking words. The web app cannot tell the window in front, so Settings recommend a share of one window or one tab.
  - A screen lock or sleep stops the capture until the owner is back. When the share goes away, the capture ends, and the owner starts it again.
- **Inspector.** The status store replicates the state, the frame count, the app in front, and the count of skipped frames to every window. The window title stays out of it.

Step 3-2 built the detectors as follows. Their events do not reach the pressure yet.

- `ScreenDetector` in `packages/stage-shared` reads the 64 by 36 thumbnails, the time, and the app in front. It runs in the perception runner on the leader, with no model call.
- **Frame change.** The mean brightness change between frames, from 0 to 1.
- **Activity.** A moving average of the frame change, with a half-life of 5 seconds. It is a level, not an event. Commentary uses it for its pace in step 3-5.
- **Settle, then compare.** A frame with a change of 0.01 or more starts a movement. Two still frames, one second, settle the screen. Then the detector compares the new still screen with the last still screen. A change of 0.02 or more is a `scene-change` event.
- **Noise floor.** A screen that never stops, for example an animated game lobby, never settles with a fixed threshold. A desktop check showed this. The detector therefore follows the usual frame change: it rises with a half-life of 15 seconds and falls with one of 2 seconds. A frame below 1.5 times this floor is still, and a scene change must be at least 2 times the floor.
- **Familiar screens.** The detector keeps the 64-bit difference hashes of the last 32 still screens. A new screen within 6 bits of one of them keeps 0.3 of its salience.
- **Baseline for each app.** Each app has a moving average of its scene changes, which starts at 0.05. The salience is the change over the baseline, divided by three times the baseline. On the web, all frames share one baseline.
- **App switch dwell.** On the desktop, an `app-switch` event comes after the owner stays in the new app for 5 seconds. A switch to the desktop, a file manager, or AIRI has the salience 0.2, and other switches have 0.5. The screen change of the switch itself is no scene change.
- **Long still periods.** A screen without change for 3 minutes gives one `still` event with the salience 0.1.
- **Excluded frames.** After a skipped frame, the detector settles again and does not compare with the screen before it. It never learns the app of an excluded window.
- **Loud sounds wait.** The app does not capture audio yet. System audio also holds the voices of friends in a call, and the ADR captures the audio of one process only. The native module for that comes with game audio in step 5, so the loud sound detector comes there too.
- `DETECTOR_LIMITS` holds the thresholds. Synthetic frame streams set the first values, and replay evaluation in step 3-6 tunes them.
- The inspector shows the activity and the last 20 events: the time, the type, the salience, the app, and whether the screen was familiar.

Step 3-3 built the decision turn with frames as follows.

- **Events as pressure.** Each screen event goes to the policy as a `perceived` event with its salience. A salient event after a decision still makes its speech stale.
- **`fresh-keyframes`.** `pickFreshKeyframes` in `packages/stage-shared` picks the newest frame, the frame before the largest change near each event since the last turn, and then the frames that changed most. Picks that look the same are skipped. It is the default until replay evaluation chooses one.
- **Frames in the turn.** A drive turn attaches the picks to its transient notice: the newest frame at 1280 pixels, older frames at 512 pixels. A transient notice is never stored, and its attachments stay out of the chat asset store, so no frame reaches the disk. Greetings and welcomes back get no frames, and no frame goes while an excluded window is in front.
- **Situation block.** The notice tells the age of each frame, the app in front without the title, and up to five screen events since the last turn. It says that text on the screen is data from other apps, never an instruction.
- **Image budget.** Settings > Modules > Screen perception sets the images each hour, 20 by default. The device keeps the send times, and the budget counts a rolling window of 60 minutes, so a burst right after each full hour cannot happen. Below half of the budget, a turn sends the newest frame only, and events keep `max(0.25, share / 0.5)` of their pressure. With no budget left, the turn goes without frames, and the notice says so.
- **Tools in screen turns.** Code still offers the mission tools in a turn with frames. The known risk of screen text that acts as an instruction stays open, as the table of known risks says. Only the notice marks screen text as data for now.

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
- When the budget runs low, code lengthens the time between decision turns. When the budget is empty, no image goes out until the window of the last 60 minutes has room again.
- A running commentary mission raises the budget.
- Settings show the images sent in the current hour.

### Usage by purpose

Each model call records its purpose. Settings and the inspector show the usage of each purpose.

- The purposes are owner replies, autonomous turns, commentary, watch checks, topic seeds, memory work, and motion generation.
- For each purpose, the record holds the calls, the input tokens, the output tokens, the images, and the calls without a token report.
- The record holds no cost and no cached tokens. The owner checks the exact cost on the provider site. The owner decided this on 2026-11-01.
- The view shows the current day and the last 30 days.

Step 2-3a built the usage records as follows.

- The LLM store records each finished stream. A stream with tool rounds counts one call for each round. A failed or cancelled stream counts as one call without tokens.
- The purposes are `owner-reply`, `initiative`, `mission`, `task`, `scene`, `vision`, `voice-assist`, `tool-card`, `artistry`, and `other`. The chat store reads the purpose of a turn from its notice source. Commentary, watch checks, topic seeds, memory work, and motion generation get a purpose in their own steps.
- IndexedDB keeps one record for each day, purpose, and model, for 30 days. The records stay on the device and never sync.
- Settings > Usage shows the tokens of each purpose for today and for the last 30 days.

### Inspector

The inspector is a panel on the main stage screen. A developer setting turns it on. It shows why the character speaks or stays silent.

- It shows the drive, the threshold, and the inner state as a graph over time.
- It shows the current gate reason, the mode, the running missions, the intentions, and the topic heat.
- It shows the timeline, the scene state, the frames of the last turn, and the usage by purpose.
- It shows the active owner changes, and it can reset them.
- The panel reads state only. It does not change the policy.

Step 2-3b built the inspector as follows. It changed the place of the inspector.

- The inspector is a devtools page, not a panel on the stage. The desktop main window is small and transparent, so a panel covered the model. The settings window shows the page beside the model. Settings > Developer opens it in both apps.
- `initiativeReadout` of `core-agent` reads the drive, its parts, the threshold, the inner state, the gate reason, the refractory time, the lines without a reaction, the interval factor, and the budget. It decides nothing.
- Only the leader holds the policy state. While a page watches, the runner publishes a readout each second through a synced store. The page marks itself each 5 seconds, so a closed page stops the publish.
- The page draws the drive and the threshold of the last 10 minutes. It also shows the open intentions, the active missions, the owner changes with a reset, and the tokens of today.
- Topic heat, the timeline, the scene state, and the frames come with steps 2b and 3.

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
- The model speaks or stays silent. With markers, it can also write a timeline note or update the scene state. With a tool, it can write an intention.

Without the screen, a decision turn works as follows. Step 2-1 built it.

- The renderer leader asks the policy each second. A turn sends a transient notice to the conversation that the owner has open.
- The notice is the situation block. It gives the reason, the time of day, the time since the last messages, the speech type hint, and the last three autonomous lines.
- Only that request reads the notice. History keeps the reply only, so a silent turn leaves no trace.
- The gates read four states: owner typing, owner speech input, speech playback, and a running chat turn.
- Each chat input reports typing through a small synced store, so the leader sees typing in every window. Typing lasts at least 15 seconds after the last input, and for a whole input method composition. An empty input ends it.
- When the owner types, speaks, or queues a message during a turn, code cancels the turn. The turn closes as `dropped`. The drive stays, so the character speaks again with fresh context after the owner stops.

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

Step 3-5a built commentary and interruptions as follows.

- **Start.** The model starts the `commentary` template with `builtIn_startMission`: the app of the window to watch, empty for the app in front, and 5 to 180 minutes, 60 by default. Code refuses it while autonomous speech or screen perception is off, and while another foreground mission runs.
- **Target window.** The desktop captures the front window of the app only. `get-windows` lists the open windows, and their Windows handle names the window source of `desktopCapturer`. Frames pause while the app is not in front. On the web, the shared window is the target.
- **End.** The commentary ends when its window closes, as the ADR says, with the reason `target-closed`. The capture track ends, or a check every 5 seconds finds no window. It also ends when the owner says stop, on a request for quiet, and at its time limit. The time limit is a guard that the ADR did not name. Time away does not end it, because the owner can watch a video without input.
- **Pace.** The policy switches to its commentary mode. Its interval follows the screen activity: 2 times on a still screen down to 0.5 times on a moving one, from the 45 seconds of the mode.
- **Images.** While a commentary runs, its own budget replaces the normal one, 120 images each hour by default. A commentary turn sends two frames at most. The usage purpose is `commentary`.
- **Interruptions.** An event of 0.8 or more that is 0.3 above the event of the current line interrupts the line. Below 0.95, the playing clip, one sentence, ends first, and the rest is dropped. From 0.95, the line stops at once with the fade of the voice controller. Another interruption waits 15 seconds. The timeline notes the cut line.
- `stopAfterCurrent` of the playback groups in `pipelines-audio`, and `afterCurrentClip` of the voice controller and the speech bus, let the current sentence end.

### Timeline and scene state

- The timeline is a list of short notes with times.
- Code writes app switches, owner speech, mission starts, and interruptions. The model writes what it sees, for example "the boss fight started".
- Old notes are summarized so that the list stays short.
- The timeline is the only history of what happened on screen.
- The scene state is one short text that the model updates. It describes the current scene, not its history.

Step 3-4 built the timeline and the scene state as follows.

- **Markers, not tools.** The model writes `<|NOTE a short fact|>` and `<|SCENE the current scene|>` in its reply, like the topic label of step 2b-2a. A tool would need a second model call in each turn, because the model answers again after the tool result. The orchestrator reports the markers through `onTimelineMarker`, also from a reply that stays silent, and keeps them out of speech and plugins. One reply writes two notes at most.
- **Code notes.** While perception runs, code notes app switches, owner messages without their text, and mission starts and ends. Interruptions come with step 3-5.
- **Storage.** Each conversation has its own timeline in IndexedDB on the device. It never syncs, because it describes the screen. A deleted conversation deletes its timeline, and the module reset deletes all timelines.
- **Limits.** A note has 120 characters, the scene 300. Past 30 notes, or for notes older than 12 hours, the chat model summarizes the oldest notes with the earlier summary in a background call with the usage purpose `timeline`.
- **Prompt.** A drive turn with the screen gives the scene, the summary, and the newest 12 notes, and it asks for the markers. A reply to the owner does not get the timeline yet.
- The inspector shows the scene, the summary, and the newest notes of the open conversation, and it clears them.

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

Step 2b-1 built the daily rhythm as follows. Step 2b-2 builds topics and small talk.

- The greeting and the welcome back are rhythm turns in code, not mission templates. They need no instances, so templates as recipes wait until the owner or the model makes templates.
- `requestRhythmTurn` of `core-agent` starts them without the drive and the threshold. The refractory time does not hold them, but owner input, speech, a running turn, a quiet time, quiet hours, and the daily budget do. A rhythm turn that the gates hold for two minutes is dropped.
- Greeting: at the first tick of the leader, an open conversation that was quiet for 3 hours or more gets a greeting. The notice gives the time of day and the time since the last message.
- Welcome back: no input for 10 minutes makes the owner away. A screen lock or sleep makes the owner away at once. A return after 30 minutes or more gets a welcome back, but not within 10 minutes of another rhythm turn. The notice gives the time away.
- The desktop app reads `powerMonitor.getSystemIdleTime()` every 15 seconds through an eventa invoke. The web app counts input and visibility of the page only, because the Idle Detection API asks for a permission.
- Night is 22:00 to 05:00. At night, the threshold is 1.5 times higher. Jokes and questions get lower weights, and passing thoughts and quiet remarks get higher ones.
- Settings > Modules > Autonomous speech turns the greeting and the welcome back on or off. Both are on by default. The inspector shows whether the owner is away and the last rhythm turn.

- Code checks each value that the model gives. The model can only create and stop instances.
- A mission instruction has 500 characters at most. It never replaces the persona.
- One foreground mission runs at a time, for example commentary or small talk. Background missions, such as reminders and watches, enter the prompt only when they fire.
- A notice gets a `mustSpeak` option. Today a notice stays silent when the model gives no visible reply, so it cannot carry a reminder.
- A watch uses a check turn, not a speech turn. A change in the region, or a slow timer, starts the check.
- In a check turn, the model gets a small crop and answers with a tool. Only a "yes" starts a `mustSpeak` notice.

Step 3-5b built the `watch` template as follows.

- **Start.** The model starts it with `builtIn_startMission`: the condition in the owner's words, the app, empty for the app in front, a region, and 5 to 360 minutes, 60 by default. Code refuses it while screen perception is off, and while another watch runs.
- **Region.** The ADR did not tell how the owner names the region. The model picks a named region from the owner's words: the whole window, or one cell of a 3 by 3 grid, for example `top-right`. Free coordinates would be a guess.
- **One at a time.** One watch runs at a time, so the capture has one target. A watch is a background mission, so it runs beside small talk or commentary. A commentary keeps the capture, and the watch then checks only while its app is in front.
- **Check turn.** The watch runner checks at once, then on a change of 0.03 in the region of the thumbnails, at most every 10 seconds, and at least every 60 seconds. It sends a crop of 512 pixels at most to the chat model of the conversation, outside the conversation, with the usage purpose `watch`. The model answers with `report_watch`, and the call stops after the answer. Each check counts one image in the image budget, and checks wait while the budget is empty.
- **Yes.** A "yes" sends a `mustSpeak` notice with the reminder fallbacks: one more try, then a fixed text. The watch ends as `done` with the reason `condition`, and the timeline notes it.
- **End.** The watch also ends when its window closes, when the owner stops it, and at its time limit. The time limit is a guard that the ADR did not name.
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

Step 2b-2a built topics for every autonomous turn as follows. The `small-talk` template comes next.

- **Topic label.** The notice asks the model to end its line with `<|TOPIC a few words|>`. The orchestrator stores the label on the reply as `topic`, like a sticker marker. The label is not spoken or shown, and it needs no extra model call.
- **Topic history.** The runner reads the autonomous lines of the open conversation from the last 3 days. Each line has its label, or its text when it has no label. It needs no storage of its own.
- **Thread and heat.** Consecutive lines with a similarity of 0.5 or more are one thread. A line that the owner answered multiplies the heat by 0.85. A line without an answer multiplies it by 0.55. At 0.35 or less, the thread is cold, and the notice asks for a new topic.
- **Seeds.** The pool has the memory index lines of the card and calendar seeds: the month, the day of the week, and the start or end of a month or year. Code draws up to three seeds by weight. A seed near a recent topic gets a lower weight, and one with a similarity of 0.6 or more is not offered. A seed that a spoken turn offered rests for six hours. The similarity misses a seed in another language than the lines, for example an English calendar seed and a Japanese line, so the rest keeps the seed from coming back each turn. The rest lives in memory only.
- Rhythm turns get no seeds, because they have their own reason. Intentions stay in their own list of the notice. Screen events come with step 3, and owner interests, character interests, and a seed call come later.
- **Similarity.** Code compares topics with the share of shared character pairs. This is a temporary step: the client has no text embeddings yet. The similarity is a function that the host can replace. When the memory ADR adds embeddings, the stored labels get embeddings, and the similarity of embeddings replaces character pairs.
- **Variety.** `core-agent` measures `distinct-2`, the entropy of the speech types, and the similarity of consecutive topics. The inspector shows the thread, the seeds of the last turn, and the variety of today's lines. The speech types of today live in memory only, so a restart begins again.

Step 2b-2b built the `small-talk` template as follows.

- **Template.** `small-talk` is a built-in template in code, like `reminder`. Templates as recipes still wait, as step 2b-1 decided.
- **Trigger.** Only an owner request starts it. The model starts it with `builtIn_startMission` for 5 to 120 minutes, 30 when the owner names no time. "A quiet owner nearby" waits, because it is close to the normal idle talk, and a faster pace without a request can annoy the owner. [The idea notes](../context/autonomy-ideas.md) keep it.
- **Gates.** Code refuses small talk while autonomous speech is off, and while another small talk runs. It is the only foreground mission so far.
- **Speech style.** While it runs, the idle interval is 2 minutes and the rest after a turn is 45 seconds. The owner's temporary factor, for example "talk less", still applies. Lines without an owner answer still make the interval longer. The daily budget and quiet hours still hold. The notice names small talk and the time left. Topics work as in step 2b-2a.
- **End rule.** The mission runner ends it at its time limit. `builtIn_stopMission` ends it when the owner says stop. The initiative runner ends it when the owner leaves, from the away detection of step 2b-1. A request for quiet also ends it. The instance keeps the reason: `time`, `owner`, `away`, or `quiet`.
- **Instances.** `MissionInstance` is a union of the templates. Small talk has the state `running`, and it ends as `done` at its time limit or `stopped` otherwise. After a restart, small talk before its time limit goes on.
- **Tool values.** The values of `builtIn_startMission` are the reminder values or the small-talk values (`anyOf`). The reminder values did not change. A new template still needs no new tool.

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

[ADR 2026-11-02](./2026-11-02-long-term-memory-and-recall.md) covers long-term memory and sync between devices. This ADR depends on it as follows:

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

Step 3-6a built the recorder as follows.

- **Desktop only.** A browser cannot write a folder, and the recorder is a developer tool, so only the desktop app records.
- **Content.** Each frame of the ring as a JPEG, its time, its app in front without the title, its grayscale thumbnail, the screen events, and the times of the owner messages without their text. This is enough to replay detection and decisions in step 3-6b.
- **No audio yet.** The ADR records audio too, but the app captures no audio until game audio in step 5.
- **Folder.** The main process writes `perception-recordings/<start time>/` in the user data folder of the app: `frames/<n>.jpg`, `frames.jsonl`, `events.jsonl`, and `manifest.json`. The folder is fixed. Settings show and open it, and a choice of folder can come later.
- **Control.** Settings > Developer > Screen Recorder starts and stops a recording, lists the recordings, deletes one, and opens the folder. A recording needs running perception. A pause, a screen lock, a leader change, or the end of the share stops it. While it records, the eye button turns into a red record mark.
- **Limits.** A recording stops by itself after 20 minutes or 1 GB. At 2 frames each second, it writes about 13 MB each minute. A delete touches only the folders of the recordings.

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

Step 3-6b built the replay evaluation as follows.

- `evals/autonomy-replay` is a vieval suite in the form of `evals/asr-rewrite`. The owner runs it by hand, because it calls paid models and sends recorded frames to the provider.
- It calls OpenCode Go through its OpenAI-compatible endpoint, the same provider as the app, so the results hold for the app. The judge uses the speaking model unless a judge model is set.
- For each recording, the detectors read the recorded thumbnails, the initiative policy decides on the clock of the recording with a seeded random source, and the frame policy picks the frames of each turn. The owner messages of the recording reach the policy at their times. A spoken line holds further turns for its estimated playback time.
- The speaking model gets the notice of the app with the frames, and the NOTE and SCENE markers of its replies build the timeline of later turns.
- The judge gets the frames before each line and the screen after it, and answers whether the line is grounded and whether it contradicts the timeline.
- The report holds the metrics above, the tokens with the cache share, and no prices. The interruptions per minute wait: a recording has no playback times. Each case writes its lines to `replay.json`.
- The unit tests replay a synthetic recording with a fake model, without network.

Step 3-6c added the other frame policies as follows.

- `packages/stage-shared` holds the four policy names and their pure parts, so the app and the replay pick the same frames.
- `contact-sheet` takes the picks of `fresh-keyframes` and fills the rest with frames spread evenly since the last turn. Up to six tiles of 426 by 240 pixels go in three columns, oldest first.
- The app draws the sheet with an `OffscreenCanvas`. The replay draws it with `@napi-rs/image` in the same layout.
- `scene-anchor` keeps one anchor frame for each scene. A scene change or an app switch starts a scene, and the first frame after it becomes the anchor. The anchor stays until the next boundary.
- The anchor is a user turn right after the system prompt, before the history summary. The ADR said a fixed part of the prompt. A user turn keeps the system prompt text the same, and the provider cache can still read the start of the request.
- The anchor and a contact sheet each count as one image. With one image left in the budget, the newest frame or the sheet wins over the anchor.
- The notice says how old the anchor is, and that the tiles go left to right and top to bottom, oldest first.
- A developer setting on the perception page chooses the policy. The default stays `fresh-keyframes` until the owner runs the replay and chooses one.
- The replay runs all four policies for each recording and model. `AUTONOMY_REPLAY_POLICIES` limits the list, so a run costs less. The judge sees the tiles of a sheet as single frames.
- Nobody has measured yet whether the provider cache covers the anchor image. The replay records the cache share for each policy, so the owner can check it.

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
| 2 | Autonomous talk without the screen: connect the policy core to `notifyConversation`. Add the prompt budget, intentions, owner control, usage by purpose, and the inspector. | Done |
| 2b | Daily rhythm and small talk: templates as recipes, the `greeting`, `welcome-back`, and `small-talk` templates, topic seeds, and the time of day. Measure variety. | Done. Templates as recipes still wait. |
| 3 | Perception: the adapters, ring buffer, detectors, frame policies, image budget, recorder, replay, timeline, scene state, `commentary` with interruptions, and `watch`. | Done. |
| 4 | Motion: the model capability check, the procedural layer, the library with `ACT` markers, expression sync, and the upper-body layer. | To do |
| 5 | Generated motion, game audio, recall from memory, and polish. Recall needs the memory ADR. | To do |

Step 2 has four parts. Each part is one change.

| Part | Content | State |
| --- | --- | --- |
| 2-1 | Connect the policy to the conversation: the runner on the leader, the transient notice, the situation block, the gates, typing detection, the cancel on owner input, and the settings. | Done |
| 2-2 | Intentions, owner control with words, and implicit feedback. | Done |
| 2-3 | Usage by purpose and the inspector. | Done |
| 2-4 | The prompt budget: the top memories and the history summary. It changes every request, so it comes last. | Done |

Step 3 has nine parts. Each part is one change. Detector events reach the pressure only in 3-3, when the model can also see the frames.

| Part | Content | State |
| --- | --- | --- |
| 3-1 | The screen sources of the desktop and web apps, the ring buffer, and the privacy rules: opt-in, the indicator and pause, the exclusion list, and the stop on lock. | Done |
| 3-2 | The detectors: settle then compare, familiar screens, the baseline for each app, the app switch dwell, and long still periods. The inspector lists the events. The loud sound detector waits for step 5. | Done |
| 3-3 | The decision turn with frames: `fresh-keyframes` as the first default frame policy until replay chooses one, images in the transient notice, the image budget, events as pressure, and screen text as untrusted data. | Done |
| 3-4 | The timeline and the scene state, written with markers. | Done |
| 3-5a | The `commentary` template with the target window, its pace, its budget, and interruptions. | Done |
| 3-5b | The `watch` template with check turns and named regions. | Done |
| 3-6a | The screen recorder of the desktop app. | Done |
| 3-6b | The replay evaluation suite. | Done |
| 3-6c | The `contact-sheet` and `scene-anchor` frame policies, and a developer setting to choose the policy. | Done |

Step 4 does not depend on steps 0 to 3. It comes after them so that the speech output format changes only once.
The memory ADR has its own steps. They can run beside steps 1 to 4.

## Work outside the steps

The owner asked for this work between the steps. It is not in the step table, but some of it supports later steps.

| Work | Where | State |
| --- | --- | --- |
| VRM motions on MMD models: the `.vrma` retarget in [Body: motion](#body-motion), and the VRM idle loop as the default MMD idle. Helper IK, for example `左腕WIK` under `左ひじ`, follows its parent. | `packages/stage-ui-mmd` | Done. It is the base of the step 4 library on MMD models. |
| MMD import from a folder: a model choice for a folder or ZIP with several models, and Shift_JIS ZIP names. | `packages/stage-ui-mmd`, `packages/stage-ui` | Done |
| MMD graphics, phase 1: the post-processing presets `off`, `low`, `medium`, and `high`. They add bloom, tone mapping, color grading, the vignette, and anti-aliasing. | `packages/stage-ui-mmd` | Done |
| MMD graphics, phase 2: the `toon`, `hybrid`, and `pbr` render modes. They add environment light, soft shadows, a rim light, ambient occlusion, and tuning for each material. | `packages/stage-ui-mmd`, `packages/stage-ui` | Done. Not checked in the desktop app yet. |
| MMD graphics, phase 3: depth of field that keeps the head bone `頭` sharp, and chromatic aberration. Depth of field works only with a background image. | `packages/stage-ui-mmd`, `packages/stage-ui` | Done. Not checked in the desktop app yet. |
| MMD graphics, phase 4: stage models (`.x` and PMX) and particles. | — | On hold |
| Settings sync between devices through a self-hosted server. [ADR 2026-10-31](../../../server/docs/ai/adr/2026-10-31-settings-sync.md) has the design. API keys do not sync. | `server/apps/api`, `packages/stage-ui` | Done. Memories, recipes, and missions wait for the memory ADR. |
| A proxy for the OpenCode Go API in the web dev server. | `apps/stage-web` | Done |
| Desktop fixes: the floating chat no longer stays empty after a side switch. The overlay windows hide the Vue DevTools button. | `apps/stage-tamagotchi` | Done |

## Open work

- Agree on the step 0 defaults with the owner. They are about 15 minutes for idle talk, 45 seconds for commentary, and 200 turns each day.
- Set the default image budget.
- Choose the default exclusion list with the owner.
- Measure whether the OpenCode Go cache applies to images.
- Find a CORS solution for the production web build.
- Build [ADR 2026-11-02](./2026-11-02-long-term-memory-and-recall.md) for long-term memory and sync between devices. It also defines the floor between devices.
- Choose the native module for the capture of one process with the owner, before step 5.
- [The idea notes](../context/autonomy-ideas.md) keep the features that the owner held for later.
- Decide whether a realtime API enters a later ADR.
