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

## Rejected options

- **A vision model before the chat model.** It made fewer wrong lines, but each line came 3 to 5 seconds later.
- **A generic CORS proxy.** A relay that forwards to any URL lets a page reach every host through the app.
- **A local HTTP server in Electron main.** It needs a port and an invoke in each window to tell the port. The custom scheme needs neither.
- **A route on the API server for the desktop app.** Chat then stops when the local backend does not run.
- **The relay URL in the provider config.** A config from the desktop app then breaks the web app after a sync.
- **A pixel detector for the moment to speak.** At the same trigger rate, it found 73% of the important events.

## Steps

| Step | Content | Workspaces | State |
| --- | --- | --- | --- |
| 1 | The provider relay, its two hosts, and the provider `opencode-go`. | `packages/stage-shared`, `packages/stage-ui`, `apps/stage-tamagotchi`, `apps/stage-web`, `packages/i18n` | This change |
| 2 | Remove the Vite proxy entries and the screen model of the perception settings. | `apps/stage-web`, `packages/stage-ui`, `packages/stage-pages`, `packages/i18n` | To do |
| 3 | The client of Gemini Decision 1. | `packages/core-agent`, `packages/stage-ui` | To do |
| 4 | The screen gate, the choice of four answers, and the frame input of a commentary line. | `packages/core-agent`, `packages/stage-ui` | To do, with its own section in this document |

## Consequences

- An owner who used "OpenAI Compatible" with the Vite proxy must add the provider "OpenCode Go" and select its model. No code moves the old config.
- The screen model that an owner selected has no effect after step 2. Screen turns use the chat model of the character.
- The web app reaches OpenCode Go only through `pnpm dev:web` or a preview server.
- The reasoning table needs an update when OpenCode Go adds a model. Until then, a new model reasons as the server decides.
- Autonomous turns need a Gemini API key after step 4. Its free tier allows 10,000 requests each day.

## Verification of step 1

- Unit tests cover the relay, the Node adapter with a real HTTP server, the handler of the custom scheme, and the provider definition.
- Through the relay of the web dev server on 2026-11-14: the model list gave 30 models, a chat request without a key gave the HTTP 401 of the server, and a streamed reply of `gpt-6-luna` gave its first text after 1.0 second.
- The desktop relay was not run against the server in the app. The key of the owner must be in the app settings for that check.
