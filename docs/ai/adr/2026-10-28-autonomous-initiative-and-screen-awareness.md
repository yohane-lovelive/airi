# Autonomous initiative and screen awareness

Status: proposed

## Context

AIRI speaks only after an owner message or a module event. The owner cannot expect the character to start a conversation, as Neuro-sama does.

The character also does not know what the owner does on the PC. The screen pipeline exists, but it has these gaps:

- Only `devtools/vision.vue` starts the screen ticker. The owner must keep that page open and pick the source by hand.
- The ticker calls the vision model every 3 seconds, also when the screen does not change.
- `publishContext` is off by default.
- The context reaches the model only with the next owner message. A screen change never starts a turn.
- The pipeline has no exclusion rule and no pause for a locked screen.

These parts already exist and this change reuses them:

- `notifyConversation` in `packages/stage-ui/src/stores/chat.ts` sends a notice to the owner conversation. The model then speaks or stays silent. A silent notice leaves no history.
- The renderer leader runs background work, so several windows never do the same work twice.
- `powerMonitor` events for suspend and lock screen reach the renderer through Eventa.
- The vision store, the orchestrator, and `sendContextUpdate` produce and publish the screen description.

[ADR 2026-10-10](./2026-10-10-skills-automations-and-memory.md) describes auto-run recipes with triggers, conditions, and a cooldown. The code on `main` has no automation yet.

## Decision

AIRI gets two features that work together. Screen awareness gives the character the screen context. Initiative lets the character start a turn.
Both features are off by default and apply to `apps/stage-tamagotchi` only.

### Initiative

- A trigger is an event that can start a turn: a silence of a set length, a large screen change, a return after time away, or a timer with jitter.
- Code decides each trigger and each gate without a model call.
- A gate stops a turn when the owner types or speaks, when the character speaks, or when a turn runs.
- A gate also stops a turn in quiet hours, in a cooldown, and when a daily budget is spent.
- The cooldown grows when the owner does not react to an initiative turn, and returns to the base value when the owner reacts.
- When a trigger passes every gate, the host calls `notifyConversation` with the source `initiative:<trigger>`.
- The notice text names the trigger and the elapsed time. It also holds the recent initiative lines, so the model does not repeat itself.
- The model decides to speak or to stay silent. Code does not fake a reply.
- The owner sets the base interval, the quiet hours, and the daily budget. The default interval is conservative: one turn in 5 to 10 quiet minutes.
- A module event through `spark:notify` keeps its own path and does not use these gates.

### Screen awareness

- A watcher runs in the renderer leader. It does not depend on a devtools page. The owner picks the capture source once in Settings, and the app keeps it.
- The watcher shrinks each frame and compares it with the last frame. It calls the vision model only when the difference passes a threshold.
- The watcher lengthens the interval while the screen stays still and shortens it while the screen changes. Both ends of the interval have limits.
- The watcher publishes a short text description as the context `screen:activity` with `ReplaceSelf`. It attaches no image by default.
- A digest keeps the last few descriptions in memory only. The digest never reaches the disk.
- A large change in the digest is a `screen-change` trigger for Initiative.

### Privacy

The vision model is a cloud model. A frame leaves the PC, so these rules are mandatory in the first release:

- Screen awareness is opt-in. Settings state that the app sends screen content to the selected cloud provider.
- An indicator shows while the watcher runs. One click pauses it.
- An exclusion list names apps and window titles. A match skips the frame. The default list holds password managers, banks, and messengers.
- The watcher pauses on suspend, on lock screen, and when the source disappears.
- The app stores no frame. Only the text description is kept, in memory.

### Settings and cost

- The owner sets the capture interval range, the change threshold, and the daily budget of vision calls. The budget also bounds cost.
- Initiative and screen awareness each have a switch. Initiative works without screen awareness, with the silence and timer triggers only.

## Implementation boundaries

- `packages/core-agent` owns the portable policy: triggers, gates, backoff, and budget. These are pure functions with a clock input.
- `packages/stage-shared` owns the frame comparison, so it has no Vue dependency.
- `packages/stage-ui` owns the stores, the watcher loop, and the connection to `notifyConversation` and the vision orchestrator.
- `apps/stage-tamagotchi/src/main` owns the idle time and the window list for the exclusion rule.
- Eventa contracts for these calls live in `apps/stage-tamagotchi/src/shared`.
- Strings live in `packages/i18n`. Only the English locale and the locale of the author change.
- The renderer leader runs both features. Other windows read state.

## Relation to automations

The names `trigger`, `condition`, and `cooldown` follow ADR 2026-10-10. Initiative ships first as its own module because the automation code is not on `main`.
When automations land, Initiative becomes a preset automation and its gates become conditions. Then this ADR needs an update.

## Validation

- Deterministic tests with a fake clock cover each trigger, each gate, the backoff, and the budget.
- Tests for the frame comparison cover a still frame, a small change, and a large change.
- A store test makes sure that a gate stop never calls `notifyConversation`.
- Browser tests cover the settings page and the indicator.
- Live checks with a real cloud model and a real screen are not part of CI. Record them in the PR.

## Non-goals

- A local vision model. The first release supports cloud providers only.
- Screen awareness in `stage-web` and in `apps/stage-tamagotchi-kirie`.
- Control of the PC from the screen content. Computer use has its own tools.
- Storage of frames or of a long screen history.

## Steps

| Step | Content | Workspaces | State |
| --- | --- | --- | --- |
| 0 | Run the existing vision pipeline with `publishContext` on, and note the quality and cost. | `apps/stage-tamagotchi` | To do |
| 1 | Initiative with the silence and timer triggers, the gates, and the settings. | `packages/core-agent`, `packages/stage-ui` | To do |
| 2 | Resident watcher with the change check, the exclusion list, and the indicator. | `packages/stage-shared`, `packages/stage-ui`, `apps/stage-tamagotchi` | To do |
| 3 | The `screen-change` trigger, the digest, and the budget. | `packages/core-agent`, `packages/stage-ui` | To do |
| 4 | Topic ideas from memory and short reactions. | `packages/stage-ui` | To do |

## Open work

- Check upstream issues and pull requests for automation work before step 1.
- Choose the default exclusion list with the owner.
- Measure the cost of one hour of screen awareness with a real cloud provider.

