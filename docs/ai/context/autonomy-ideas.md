# Autonomy idea notes

Japanese version: [autonomy-ideas.ja-JP.md](./autonomy-ideas.ja-JP.md)

This file keeps features that the owner held for later. They are not part of [the autonomy ADR](../adr/2026-10-28-autonomous-character-perception-and-missions.md).
Each entry tells what the feature is, why it waits, and when to look at it again. Before work starts on an entry, it needs its own design or an ADR change.

The "Known risks" table of the ADR keeps three more items: self-hearing, screen prompt injection, and speech during calls.

## Conversation and presence

### Do-not-disturb during calls and meetings

- **What:** The character goes quiet when another app uses the microphone, a video plays in full screen, or a recorder runs.
- **Why it waits:** The owner plans to use AIRI in Discord calls. A fixed mute rule then blocks the wanted use.
- **Look again when:** Discord voice participation has a design. The rule must know whether AIRI takes part in the call.

### Discord voice call participation

- **What:** AIRI joins a Discord voice call and talks with the owner and friends. The bot receives one audio stream for each speaker, so it knows who spoke.
- **Why it waits:** The current use is a personal desktop agent. The Discord module of AIRI handles text only.
- **Look again when:** The autonomy steps 0 to 3 work. It needs a future ADR.

### Reactions to stream viewers

- **What:** The character reads and answers the chat of Twitch or YouTube viewers.
- **Why it waits:** The current use is personal, not streaming.
- **Look again when:** The owner starts to stream with AIRI.

### Server-side turns

- **What:** The server runs the whole turn: memory search, the model call, and tools. Each device only plays the result.
- **Why it waits:** The current design keeps the model call on each device, and the server does memory search only. A full move changes the structure of AIRI.
- **Look again when:** The memory ADR is in use, and devices disagree on results or settings.

## Cost

### Daily cost limit for each purpose

- **What:** Each call purpose gets a daily cost limit. A purpose stops when it reaches its limit.
- **Why it waits:** The owner wants to see usage first. The ADR shows usage by purpose.
- **Look again when:** The usage view shows a purpose that costs more than expected.

## Perception

### Image embeddings for familiar screens

- **What:** EmbeddingGemma 2 places images and text in one vector space. Image embeddings can find familiar screens better than small hashes.
- **Why it waits:** Hashes are cheaper, and nobody has measured the gain.
- **Look again when:** Replay evaluation shows that menus or repeated screens still start turns.

### Local vision model

- **What:** A local model reads frames, so no frame leaves the PC.
- **Why it waits:** The first release supports cloud providers only. Local models of good quality need a strong GPU.
- **Look again when:** A small local model with image input gives good commentary in replay evaluation.

### Realtime streaming API

- **What:** A model such as Gemini Live takes audio and video as a stream and answers with audio.
- **Why it waits:** The design uses decision turns and a text model. A realtime model changes the speech path and the cost model.
- **Look again when:** Decision turns give too much delay for commentary, even with interruptions and the frame policies.

### Screen perception on more devices

- **What:** Screen perception in `apps/stage-pocket` or `apps/stage-tamagotchi-kirie`.
- **Why it waits:** The owner does not need screen perception on a phone.
- **Look again when:** The owner uses one of these apps on a PC.

### Game audio on other platforms

- **What:** Process audio capture on macOS or Linux, or game audio in the web app.
- **Why it waits:** The owner needs game audio only on the Windows desktop app.
- **Look again when:** The owner uses another platform for games.

## Motion

### Lip sync

- **What:** Mouth movement that follows the TTS speech. The code has `useVRMLipSync`, but nobody has verified it.
- **Why it waits:** The owner withdrew the requirement for now.
- **Look again when:** The motion layers of step 4 work.

### Speech-to-gesture model

- **What:** A small neural model turns the speech audio into upper-body motion. Examples are models of the DiffGesture or Audio2Photoreal type.
- **Why it waits:** The procedural layer and the clip library come first, and they need no model.
- **Look again when:** Gestures from the library look too repetitive.

### Motion control by the model

- **What:** The model gives gaze targets, head angles, and blend weights of poses, not clip names.
- **Why it waits:** Clips with free-text markers are simpler and give stable quality.
- **Look again when:** The library cannot express small reactions, for example a look at one part of the screen.
