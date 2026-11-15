# Autonomy: one model that sees and speaks, a provider relay, and a decision model

Status: accepted

Japanese version: [2026-11-14-autonomy-one-model-relay-decision.ja-JP.md](2026-11-14-autonomy-one-model-relay-decision.ja-JP.md)

## Context

`docs/ai/adr/2026-10-28-autonomous-character-perception-and-missions.md` gives the design of screen perception, missions, and commentary. The owner used that design with OpenCode Go as the model server. Three problems came from this use.

### Commentary was slow

The owner measured commentary on 2026-11-13 with recorded matches of one game.

- The slow part was the model. `mimo-v2.6-pro` took 5 to 45 seconds to its first token. `gpt-6-luna` took about 1.3 seconds with one image.
- A second model for the screen did not help. A path with a vision model and a chat model made fewer wrong lines, 13 against 29 in 76 lines. It added 3 to 5 seconds to each line.
- The owner selected one model for all turns: `gpt-6-luna` sees the screen and speaks.

### A browser cannot call OpenCode Go

These facts come from requests to `https://opencode.ai/zen/go/v1` on 2026-11-13 and 2026-11-14.

- Each request needs the header `x-opencode-session`. Without it, the server answers HTTP 400 `MissingSessionID`.
- The server answers a CORS preflight for `/chat/completions` with HTTP 404. The header list of `/models` does not allow `x-opencode-session`.
- The field that turns reasoning off differs by model. A wrong field gives HTTP 400. The model list of the server does not tell the field.

The owner reached the server through a `server.proxy` entry in the Vite config of each app. That entry is not a part of AIRI: the desktop entry was never committed, and a provider of the type "OpenAI Compatible" pointed at it by hand.

### The moment to speak needs a judgement

Commentary on a timer speaks when nothing happens and misses events. The owner tested a decision model for this judgement on 2026-11-13 and 2026-11-14.

- Gemini Decision 1 (`gemini-decision-1`) answers a yes or no question about two screen frames. With one question that names no game, it found 98% of 56 important events at 6.3 triggers each minute. One call took 0.85 seconds and 748 input tokens at low image resolution.
- A choice of four answers from text only (answer the owner, react to the screen, start a topic, stay silent) was correct in 88 of 101 cases. One call took 0.35 seconds and 361 input tokens.
- The cases and their expected answers came from the author of the test. The game was one match of one title.

## Decision

### One model for replies and commentary

- A turn uses the chat model of the session character. This holds for a reply, a commentary line, and each other autonomous turn.
- The separate screen model of the perception settings is removed. `gpt-6-luna` reads images, so no second model reads the screen.
- The module settings stay the place for the model. `docs/ai/adr/2026-11-11-module-defaults-and-character-values.md` gives their rules.

### A provider definition for OpenCode Go

`packages/stage-ui/src/libs/providers/providers/opencode-go` defines the provider `opencode-go`.

- The config holds the API key only. It holds no base URL, because the URL of the relay differs between the apps, and a config can sync between them.
- The reasoning field follows the model. A table in the definition gives the form for nine measured models. A model outside the table gets no reasoning field.
- The model list comes from the server. It tells which models read images, so the owner does not set that for each model.
- The mobile app does not offer the provider, because it has no relay.

### A provider relay

`createProviderRelay` in `packages/stage-shared/src/provider-relay` forwards a request of the page to a model server.

- The list of targets is closed. It holds `opencode-go` only. A request for another target gets HTTP 404, so the relay is not an open proxy.
- The relay adds the session header. It makes one session id for each start of its host.
- The relay keeps no API key. The page sends its own `Authorization` header, and the relay forwards it.
- The relay forwards `authorization`, `content-type`, and `accept`. The cookies and the origin of the page do not go upstream.
- The reply passes through as a stream.

Each app has one host for the relay.

| App | Host | Address |
| --- | --- | --- |
| Desktop | Electron main, with `protocol.handle` | `airi-relay://opencode-go/` |
| Web | The dev server and the preview server of Vite | `/provider-relay/opencode-go/` on the origin of the page |

- A test in a hidden Electron 43 window proved the desktop path: a page on an `http` origin posted JSON with an `Authorization` header to the custom scheme and read the reply in chunks.
- The `server.proxy` entries of both Vite configs are removed.
- A static deployment of the web build has no relay. A route on the API server can give one later.

### A decision model beside the chat model

- Gemini Decision 1 judges the moment to speak. It does not describe the screen, and it writes no line.
- The page calls the Gemini API directly. The server answers the CORS preflight for `x-goog-api-key`.
- The API key is the key of the provider `google-generative-ai`. No new setting holds it.
- The client lives in `packages/core-agent`. Later changes add the screen gate and the choice of four answers on top of it.
- Since step 7, it also judges whether the screen is a roster screen. It still describes nothing. The chat model reads the names.

### The replay evaluation sends the requests of the app

Each later step changes the speed or the quality of commentary. The replay evaluation in `evals/autonomy-replay` measures both on a recording, before and after a step.

- **The chat runtime of the app composes each request.** The replay speaks each turn through `createChatOrchestratorRuntime` and `streamFrom` of `packages/core-agent`. A change of the request order in that package reaches the replay too.
- **A recording holds the start of a request.** The screen recorder writes `request-start.json` at each chat request: the system prompt and the tool definitions. The replay sends them again, so a request has the size that the app sends. Without the file, the system prompt is a short persona and the times are shorter than in the app.
- **No tool runs.** The replay answers each tool call with a fixed text, so a replay changes no memory and no mission.
- **The request is a stream with the session header.** OpenCode Go rejects a request without `x-opencode-session`. The replay reads the time to the first text from the runtime, and the cached input tokens from the stream.
- **A play video becomes a recording.** `import-video` takes 2 frames each second with ffmpeg and writes the format of the screen recorder.
- **The question of the screen gate lives in `packages/core-agent`.** The gate trace asks it about a recording, one look each 2 seconds, and scores the passes against labeled events. The app calls the same question in step 7.
- **New metrics.** The time to the first text (the median, and the time that 9 of 10 lines stay under), the input tokens for each line, and the share of repeated lines.

### A reply is one final answer, and it ends at its end marker

`gpt-6-luna` wrote on after most lines of an autonomous turn: stray words, the line again, or a run without end. The Responses route of OpenCode Go showed the cause. The model wrote its line as a message of the phase `commentary`. Then it wrote the final answer, which was empty or the line again. The chat route joins both messages.

- **The system prompt ends with the final answer rule.** The chat runtime adds `FINAL_ANSWER_RULE` of `packages/core-agent` as the last text of each system prompt, after every supplement. The rule works only in the system prompt.
- **The notice of an autonomous turn does not use the word "commentary".** With the word, the model wrote a commentary message more often.
- **A reply to a notice ends at its end marker.** The notice names the last marker that its text asks for: `NEXT`, or `TOPIC` for solo talk. When text follows that marker, the runtime stops the model request and drops the text. The speech and the history get the reply up to the marker.
- **A line break after the marker is not a tail.** The runtime cuts at other text, or at more than 16 blank characters.
- **The runtime reports each cut.** The app writes one log line. The replay evaluation gets two metrics: the share of cut turns, and the share of lines without an end marker.

### A line about the screen talks about the play

In the app check of step 5, 24 of 31 lines said the score. 2 lines named a character, and no line named a skill. The notice only said to talk about the screen. The model did not know who plays, and two single frames rarely show a move.

- **The notice says what to talk about.** A line picks one thing of the scene: what the character of the owner did, a skill that someone used, how the two sides stand, or a choice of an item. It says the score only when the lead changes. The words name no game.
- **The timeline keeps the cast of the scene.** The model writes `<|CAST ...|>` when the screen shows the names of who plays, for example a loading screen. The notice gives the cast back for 90 minutes, and a new cast takes its place.
- **Only written names count.** The cast holds names that are written on the screen, or that the owner told. In a replay the model wrote the cast from portraits. It took the wrong character for the owner's, and every later line named it.
- **The cast names the character of the owner first.** The model finds it beside the owner's player name, when it knows that name. Without it, the cast says that the character is not known.
- **A line names what is sure.** A character or an item needs a written name or the cast. A skill of a character of the cast can come from what the model knows.
- **A commentary turn sends the recent sheet.** One contact sheet holds the six frames of 12 to 2 seconds before now, and the newest frame goes at full size. The owner chose this on 2026-11-13. The developer setting of the frame policy sets the other turns.
- **The replay measures the content.** New metrics: the share of lines with a score, with a name, and with a wrong name. A recording can hold `cast.txt`, which a person wrote. The replay starts with it, and the judge checks names against it.

### A roster screen starts a cast read

A turn about the screen comes at the pace of the talk. In a replay of a match, the loading screen showed for the first 55 seconds, and the first turn came after 71 seconds. So the cast stayed empty, and no line named the character of the owner. The model also did not know the owner's player name.

- **The memory holds the owner's player names.** The memory prompt asks for one entry for each game. Its description is `Game account: ` and the game, and its body is the name. A turn about the screen reads these entries by their description, also when the index of the request does not list them.
- **The decision model finds a roster screen.** A roster screen lists the names of who takes part: a loading screen, a character select, or a table of results. Each look asks a second question in the same request as the gate question. The question names no game.
- **The screen starts the read, not a moment of the app.** The owner asked for this on 2026-11-15, because a commentary must work in every game. A game without a roster screen gets no read.
- **A cast read is a turn without speech.** The chat model gets the newest frame at full size, the owner's player names, and the cast so far. Its reply holds only markers, so nothing is spoken or stored.
- **One roster screen gets one read.** A second read runs after 8 seconds when the first one wrote no cast. A roster screen that comes back after two low looks counts as a new one. So the screen before the next match gives a new cast.
- **The read can leave the cast alone.** The notice tells the model to write only the end marker when the screen lists no names or adds nothing. Without this way out, a probe got a made-up cast for a screen of the play.
- **The owner comes first.** A read waits while the owner types or speaks, while a line plays, and while a turn runs. It counts one image of the image budget.
- **The looks run only for a commentary.** They need the key of the provider `google-generative-ai`. Without the key, no look runs, and a turn about the screen can still write the cast.
- **The answer of the gate question starts no turn yet.** The runner keeps the last look. Step 8 lets the answer start turns.
- **The replay does the same.** The gate trace asks both questions and saves both answers. A replay in the commentary mode reads them and starts the cast reads.

This changes one decision of 2026-11-13: the decision model judged only whether to react. On 2026-11-15 the owner asked to use it for the cast too.

## Rejected options

- **A vision model before the chat model.** It made fewer wrong lines, but each line came 3 to 5 seconds later.
- **A generic CORS proxy.** A relay that forwards to any URL lets a page reach every host through the app.
- **A local HTTP server in Electron main.** It needs a port and an invoke in each window to tell the port. The custom scheme needs neither.
- **A route on the API server for the desktop app.** Chat then stops when the local backend does not run.
- **The relay URL in the provider config.** A config from the desktop app then breaks the web app after a sync.
- **A pixel detector for the moment to speak.** At the same trigger rate, it found 73% of the important events.
- **A copy of the request form in the evaluation.** The evaluation of step 3-6b built its own messages. They were far smaller than the requests of the app, and they did not follow a change of the app.
- **An export button for the request start.** The settings window sends no chat request. The request start also belongs to the recorded session, so the recorder writes it.
- **A cut by symbols, scripts, and repeated sentences.** It needs no marker. But it also cuts emoticons, and a broken marker reaches the speech as text.
- **A stop sequence.** The server rejects `stop` for `gpt-6-luna`.
- **More reasoning.** With the effort `high`, 7 of 20 replies still had a tail, and the first text came after 3.2 seconds.
- **Another speaking model.** `deepseek-v4.1-flash`, `hy4`, and `muse-spark-1.3-contributor` stopped by themselves. Each one was slower to the first text, or wrong about the screen more often.
- **A part of the cast from the look of the screen.** It gave a cast sooner, but one wrong guess of the owner's character stayed in every later line.
- **A cast read at fixed moments of a commentary.** A read at the start of a commentary and at each scene change needs no decision model. But a moment of the app tells nothing about the screen, and a game without a roster screen gets requests for nothing. The owner rejected it on 2026-11-15.
- **A question about every written fact worth keeping.** For one loading screen, the chances went from 0.28 to 0.81. The question about a list of names gave 0.76 to 0.93.
- **A JSON schema for the reply.** The server holds only the final answer to the schema. With the final answer rule, 20 of 20 replies were valid JSON. But the reply of the app is text with markers, and its speech starts while the text streams.

## Steps

| Step | Content | Workspaces | State |
| --- | --- | --- | --- |
| 1 | The provider relay, its two hosts, and the provider `opencode-go`. | `packages/stage-shared`, `packages/stage-ui`, `apps/stage-tamagotchi`, `apps/stage-web`, `packages/i18n` | Done |
| 2 | Remove the Vite proxy entries and the screen model of the perception settings. | `apps/stage-web`, `packages/stage-ui`, `packages/stage-pages`, `packages/i18n` | Done |
| 3 | The client of Gemini Decision 1 and the store that gives it the key. | `packages/core-agent`, `packages/stage-ui` | Done |
| 4 | The replay evaluation sends the requests of the app. It gets the video import, the gate trace, and the question of the screen gate. | `evals/autonomy-replay`, `packages/core-agent`, `packages/stage-ui`, `apps/stage-tamagotchi`, `packages/i18n` | Done |
| 5 | The final answer rule, the notice without the word "commentary", and the end marker of a reply. | `packages/core-agent`, `packages/stage-ui`, `evals/autonomy-replay` | Done |
| 6 | What a line about the screen talks about: the focus, the cast of the scene, and the recent sheet. | `packages/core-agent`, `packages/stage-shared`, `packages/stage-ui`, `packages/i18n`, `evals/autonomy-replay` | Done |
| 7 | The screen look in the app. A roster screen starts a cast read, and the memory gives the owner's player names. | `packages/core-agent`, `packages/stage-ui`, `evals/autonomy-replay` | This change |
| 8 | The gate answer starts turns, and the choice of four answers. | `packages/core-agent`, `packages/stage-ui` | To do, with its own section in this document |

## Consequences

- An owner who used "OpenAI Compatible" with the Vite proxy must add the provider "OpenCode Go" and select its model. No code moves the old config.
- The screen model that an owner selected has no effect after step 2. Screen turns use the chat model of the character.
- The web app reaches OpenCode Go only through `pnpm dev:web` or a preview server.
- The reasoning table needs an update when OpenCode Go adds a model. Until then, a new model reasons as the server decides.
- The looks of a commentary need a Gemini API key since step 7, and autonomous turns need it after step 8. Its free tier allows 10,000 requests each day. One look each 2 seconds is 1,800 requests each hour.
- While a commentary sees its window, a frame of that window goes to the Gemini API with each look. One look costs about 890 input tokens.
- A recording holds the system prompt of the character, with the memory index. It stays on the device, like the frames.
- The replay runs one frame policy by default, the policy of the app.
- Every chat request ends its system prompt with the final answer rule: a reply to the owner and a task too. A request without a system prompt gets a system message with only the rule.
- A stopped request reports no usage, so the tokens of a cut reply are not counted.
- A reply without an end marker is not cut. A turn that stays quiet has none.
- The mission tools keep the word "commentary", because it is the name of the mission.
- A character card that names the provider "OpenAI Compatible" for its chat model must change to "OpenCode Go" too. The card selection wins over the chat settings of the app.
- The notice of a commentary turn is about 180 tokens longer, and about 150 more while the cast is not known.
- A line names the character of the owner only when the cast holds it. For that, the character must know the owner's player name, for example from a memory, or the owner must tell which character it is.
- The cast is known only after a roster screen showed while the commentary ran. A match that a commentary joins later has no cast until its next roster screen, and its lines say "an ally" and "an opponent".
- A wrong name of a cast read stays until the next roster screen. The read takes a costume name for a part of a name, and it misreads a name that the screen writes in a play on words.
- Without the key of the decision model, the cast comes only from a turn that sees a roster screen by chance.
- A commentary turn sends two images. With the default of 120 images each hour and a line each 20 seconds, the budget runs low after about 10 minutes and is empty after about 30.

## Verification of step 1

- Unit tests cover the relay, the Node adapter with a real HTTP server, the handler of the custom scheme, and the provider definition.
- Through the relay of the web dev server on 2026-11-14: the model list gave 30 models, a chat request without a key gave the HTTP 401 of the server, and a streamed reply of `gpt-6-luna` gave its first text after 1.0 second.
- Through the relay scheme in the main window of the desktop dev app on 2026-11-14: the model list gave 30 models, another target gave HTTP 404, and a streamed reply of `gpt-6-luna` gave its first text after 1.6 seconds.
- The provider `opencode-go` was not run from the app settings. The key of the owner must be in the settings for that check.

## Verification of step 3

- Unit tests cover the request form, both answer forms, a refusal of the server, and a reply without an answer.
- A test that needs `GEMINI_API_KEY` calls the real API. On 2026-11-14 it passed on the free tier: a yes or no question and a choice about one text.
- `useDecisionModelStore` of `packages/stage-ui` was not run in the app. The Google provider of the owner must hold a key for that check.

## Verification of step 4

- Unit tests cover the video import, the speaker through the chat runtime with a fake provider, the request start in a recording, the metrics, and the gate trace with its saved looks. One import test runs the real ffmpeg where it is installed.
- `import-video` turned the match of 2026-11-12 (16 minutes) into a recording of 1,932 frames.
- The gate trace of 2026-11-15 on that recording asked 482 looks on the free tier. At the threshold 0.7 the gate passed 6.3 looks each minute. It caught 66 of 67 important events, and 55% of the passes were at an important event.
- The labels of that recording come from HUD readings of `gpt-6-luna`. No person checked them.
- The replay of 2026-11-15 on that recording used `gpt-6-luna` with reasoning off, the policy `fresh-keyframes`, and the short persona. The time to the first text was 1.7 seconds at the median, and 2.0 seconds for 9 of 10 lines. A line cost about 2,300 input tokens, and the cache held almost none.
- That replay showed a fault of the model. Most lines went on after their last sentence, with stray symbols or a repeated sentence. One line did not stop: it reached 132,308 characters and 129,000 output tokens.
- A line with such a tail stays in the history, and later lines copied the tail. With a limit of 400 output tokens, all 11 lines ran to the limit.
- The speech of a long line holds the next turns, so the match gave only 7 lines without a limit and 11 lines with it. Step 5 cuts such an output before the line enters the history.
- Not checked: `request-start.json` from the running app, and a replay with a request of the size of the app. For both, the owner must record once while the character speaks.

## Verification of step 5

- Unit tests cover the rule at the end of the system prompt, the notice text, and the two metrics. For the cut, they cover the speech, the stored message, the next request, the stop of the request, a line break after the marker, a run of blank lines, the topic marker, and a reply to the owner.
- On 2026-11-15, the same 10 requests of a replay went to `gpt-6-luna` through the chat route, several times each. Without the change, 2 of 20 replies ended right after the line. With the rule in the system prompt, 46 of 60 did. With the rule and without the word "commentary", 58 of 60 did.
- The rule inside the notice did not work: 7 of 20 replies ended right after the line.
- The replay of the match of 2026-11-12 with the change gave 17 lines. The longest line had 66 characters, against 676 before. The first text came after 1.2 seconds at the median, and after 1.6 seconds for 9 of 10 lines. In 3 of 17 turns the model wrote on, and the runtime dropped that text. The replay had a limit of 1,000 output tokens, and no line reached it.
- The desktop dev app ran on a copy of the owner's profile on 2026-11-15. The system prompt of the character had 6,190 characters and 22 tools, and it ended with the rule. A reply to the owner with a tool call worked.
- In that app, a commentary on a video of the match gave 31 lines in 10.7 minutes. In the history, every line ended at its `NEXT` marker. No speech text held a marker or stray text. The runtime cut 5 replies.
- Not checked: the time to the first text in the app, the speech synthesis (it was muted), the window of a live game, and solo talk.

## Verification of step 6

- Unit tests cover the cast marker and its place in the timeline, the lines of the notice with a known and an unknown cast, the recent sheet in the app and in the replay, the cast file of a recording, and the three metrics.
- The cast of the recording of 2026-11-12 comes from its loading screen. A person read it, and one opponent is a guess from the name of a skin.
- The replay with that cast gave 17 lines. No line said the score, 16 lines held a name, and the judge found no wrong name. The first text came after 1.4 seconds at the median, and a line cost about 3,200 input tokens.
- The replay without a cast gave 15 lines. No line said the score, 2 lines held a name, and the judge found no wrong name.
- The judge is the speaking model. Its count of wrong names is weak evidence: it did not see a cast with the wrong character of the owner.
- One line of 17 named a skill. The model does not name a skill that it is not sure of.
- With the recent sheet, the first text came about 0.2 seconds later than with two single frames, at about the same input tokens.
- The desktop dev app ran on a copy of the owner's profile on 2026-11-15, on a video of the match with its loading screen held for 25 seconds. The first turn read the cast from that screen: five allies right, four of five opponents right, and no character of the owner.
- In that app, a commentary gave 24 lines in 9.4 minutes. No line said the score, against 24 of 31 before. 3 lines named a character, and no line named the character of the owner, because the cast did not hold it. The runtime cut no reply.
- After that check, the cast line got the rule for the character of the owner. On the loading screen, the model then named it in 8 of 8 tries when its memory held the owner's player name. Without the name, it said "not known" in 3 of 4 tries and guessed wrongly in one.
- Not checked: a commentary in the app with the owner's player name in the memory, the window of a live game, and a game other than League of Legends.

## Verification of step 7

- Unit tests cover the entries of the player names and their line in the memory prompt, the roster watch, the screen look with its rests, the notice of a cast read, the trace with two questions, and the cast reads of the replay.
- No test covers the wiring in the initiative runner: the ticker of the looks, and the start of a cast read.
- The gate trace ran on a video of the match of 2026-11-12, with its loading screen held 25 seconds longer. It made 495 looks of about 890 input tokens each.
- The roster answer passed 28 looks: the 26 looks at the loading screen, and 2 looks at an open scoreboard. It passed no other look at the play.
- At the loading screen, the answer of the gate question was 0.28 at most. So the gate question does not find that screen.
- The notice of a cast read ran 26 times on single frames. No reply held words to say, and each one ended with its end marker.
- With the owner's player name, 10 of 10 reads of the loading screen named the character of the owner. Without the name, 4 of 4 said "not known".
- With a cast so far, 12 of 12 reads of a scoreboard and of the play wrote only the end marker. That probe ran before the last change of the sentence about names.
- Without a cast, 6 of 12 reads of the play wrote a cast: 3 held only "not known", and 3 held player names of a list on the screen.
- The replay ran with the looks and the owner's player name. The first look started a cast read, 2 seconds after the start. It wrote the cast with the character of the owner, all allies, and 4 of 5 opponents.
- That replay gave 23 lines. No line said the score, 21 lines named the character of the owner, and the judge found one wrong name. Before this step, the same recording gave no cast.
- The replay ran 3 cast reads. The 2 reads at the scoreboard left the cast alone.
- The cast kept the costume names of 4 characters, although the notice asks to leave them out.
- The desktop dev app ran on a copy of the owner's profile on 2026-11-15, for 11 minutes on the same video. The owner set the two keys and told the player name in the chat.
- The character saved the name with the memory tool. The description of the entry was `Game account: League of Legends`.
- The app made 314 looks, one each 2 seconds, of 862 input tokens each. The console showed no failed look.
- The roster answer was 0.91 to 0.94 at the loading screen. In the play it passed 2 looks, both at an open scoreboard.
- The first look started a cast read. 18 seconds after the start, the cast held the character of the owner, all allies, and 4 of 5 opponents. It kept one costume name.
- The commentary gave 30 lines, and no line said the score. 9 lines named the character of the owner. No line named an ally, an opponent, or a skill.
- The record does not tell whether a cast read ran at the scoreboard. The cast did not change there.
- The answer of the gate question was 0.7 or more in 71 of the 314 looks.
- After the 11 minutes, 62 of the 120 images of the budget were used.
- Not checked: the window of a live game, and a game other than League of Legends.
