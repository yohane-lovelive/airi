# Long-term memory: recall by meaning and sync between devices

Status: proposed

## Context

[ADR 2026-10-10](./2026-10-10-skills-automations-and-memory.md) gave the character a long-term memory. Each fact is one entry with an index line and a body. [ADR 2026-10-28](./2026-10-28-autonomous-character-perception-and-missions.md) builds an autonomous character on top of it, and it waits for this ADR in four places:

- A device that connects later gets the same memories.
- The prompt holds the top 5 recalled memories, never the full index.
- The `recall` speech type, the small-talk seeds, and the topic similarity read memories by meaning.
- The server keeps the presence record that decides which device holds the floor.

The current code has these limits:

- IndexedDB keeps the entries on one device. A removal leaves a tombstone, but no sync reads it.
- Each request lists the newest 50 index lines in the system prompt. `builtIn_searchMemory` finds other entries by shared character pairs. It finds the same words, not the same meaning.
- The client has no text embeddings. Topic similarity also uses character pairs.
- Only the model writes memories, with `builtIn_writeMemory`. Nothing reads a conversation afterwards to keep its facts.

The backend stack already runs PostgreSQL with the VectorChord extension (`server/apps/api/sql/init.sql`). Character cards and settings already sync through the field store of [server ADR 2026-10-06](../../../server/docs/ai/adr/2026-10-06-document-sync.md).

## Decision

The server is the source of truth for memories. It also owns the embeddings. A device keeps a full copy, so recall and the chat work without a server.

### Principles

- One retrieval interface serves every reader: the chat reply, `builtIn_searchMemory`, the `recall` speech type, the topic seeds, and the topic similarity.
- Recall by meaning needs the server. Without a server, the same interface recalls by character pairs. This is a supported mode for an owner without a server, not a legacy path.
- The chat model stays free to change. The embedding model is fixed on the server, so a change of chat model keeps every memory and every vector.
- Memory text leaves the device only to the server that the owner signed in to.
- Recalled memories never change the cached prefix of a request.

### Embedding model

- The model is EmbeddingGemma 2 from Google, under the Apache 2.0 license. It supports more than 100 languages, and Japanese is one of them.
- Only its text path runs. The text part has about 270 million parameters. The vision and audio encoders stay unloaded.
- Vectors have 256 dimensions. The model makes 768 and supports Matryoshka truncation. At 256 dimensions the multilingual MTEB score falls from 61.36 to 60.41, and the storage is a third.
- A query gets the prefix `task: search result | query: `. An entry gets `title: none | text: `, followed by its index line and its body.
- The server runs the model in a small `embedder` service with Transformers.js and ONNX Runtime, with q8 weights. [The server ADR](../../../server/docs/ai/adr/2026-11-02-memory-store-and-search.md) has the details.

### Sync of memories

- Memories are a feature of the field store, `/api/v1/memories`. Each entry is one document, and its id is the UUIDv7 of the entry.
- The fields are `description`, `body`, and `persona`. A general entry has no `persona` field.
- A tombstone on the device becomes a document deletion on the server. A deletion on the server becomes a tombstone on the device.
- On a conflict, the rules of the field store apply. Two devices that change one field keep the server value, and the local entry becomes a new entry, so no fact is lost.
- The renderer leader runs the sync, like the settings sync: after a local change, on sign-in, and when the window becomes visible.
- The client experiment `memory-sync` turns it on. It is off by default.

### Retrieval interface

`recallMemories({ query, personaId, limit })` returns the best entries for a query, best first. The card's own entries and the general entries take part.

- With the sync on and the server ready, it calls `POST /api/v1/memories/search`. The server answers with entry ids and scores. The client reads the entries from its local copy.
- Entries that changed on the device after the last sync are not on the server yet. The client also scores them by character pairs and puts them after the server results.
- On a server error, or after 1.5 seconds, it recalls by character pairs.
- The interface reports which mode answered, so the inspector and IO traces show it.

### Recalled memories in the prompt

The prompt budget of ADR 2026-10-28 gives recalled memories the top 5 and about 500 tokens.

- Before each chat request, the client recalls 5 entries for the newest owner message.
- The recalled entries go into the newest user turn as a tagged part, with their ids, index lines, and bodies. They are not stored in the history.
- The system prompt keeps the index, so the model can read any entry by id. When recall by meaning works, the index lists the newest 20 entries, not 50.
- An entry that the index already lists still appears in the recalled part with its body. The index shows only one line.
- IO traces record the recall mode, the query characters, and the recalled ids.

### Autonomous readers

- The `recall` speech type recalls entries for the current topic and the scene. Code puts one of them into the situation block.
- The small-talk seeds recall entries for the current topic, not only the newest entries.
- The topic similarity of step 2b-2a compares topic labels by their vectors. It calls `POST /api/v1/memories/embed`. The client keeps the vectors of recent labels, so a label is embedded once.
- Without the server, each reader uses character pairs, as today.

### Floor between devices

- The server keeps one presence record for each account: the device id, the time it connected, and the last heartbeat.
- The device that connected first holds the floor. When its heartbeat stops for 30 seconds, the next device takes it.
- Only the device with the floor runs autonomous speech and missions. A reply to an owner message plays on the device where the owner sent it.
- The design of the presence route waits for step M4.

### Records beyond memories

Recipes, missions, intentions, and timeline notes stay on the device until step M4. Missions and intentions then sync like memories. Only the device with the floor runs them. Timeline notes stay on the device, because they describe one screen.

### Owner profile and memory work

Step M5 adds two background tasks with the usage purpose `memory`:

- An owner profile summary of about 300 tokens, which the prompt budget of ADR 2026-10-28 reserves.
- A pass over finished conversations that writes the facts the model did not save, and merges entries that say the same thing.

## Steps

| Step | Content | State |
| --- | --- | --- |
| M1 | Server: the `embedder` service, the memory feature of the field store, vectors on write, and the search and embed routes. | Done |
| M2 | Client: the memory sync, `recallMemories`, recalled memories in the prompt, and `builtIn_searchMemory` by meaning. | To do |
| M3 | Autonomous readers: the `recall` speech type, the seeds, and the topic similarity by vectors. It finishes the recall of ADR 2026-10-28 step 5. | To do |
| M4 | The floor between devices, and the sync of missions and intentions. | To do |
| M5 | The owner profile and the memory work. | To do |

## Relation to other ADRs

- ADR 2026-10-10 says that the index lists every entry. Step 2-4 of ADR 2026-10-28 already limited it to 50. This ADR limits it to 20 when recall by meaning works.
- ADR 2026-10-28 lists "Memory and devices" as its dependency on this ADR. This ADR replaces the planned direction there.
- Server ADR 2026-10-31 left memories, recipes, and missions out of the settings sync. This ADR takes them.

## Non-goals

- Embeddings on the device. The web app on a phone cannot run the model well, and every device would compute the same vectors.
- An embedding API of a provider. The owner chose a model on the own server.
- Image, audio, or screen embeddings. EmbeddingGemma 2 supports them, but this ADR embeds text only.
- Memories shared between accounts.
- Sync of frames. Frames never leave the device, except to the speaking model.

## Known risks

| Risk | Plan |
| --- | --- |
| The Transformers.js version of the catalog (3.8.1) cannot load EmbeddingGemma 2. Support came in 4.3.1. | Step M1 found it. The owner chose 4.3.2 for the embedder only. Its `package.json` pins the version, because a second catalog entry of one package fails the lint. The apps keep 3.8.1. |
| A slow server delays every chat reply. | Recall runs beside the other request work, and gives up after 1.5 seconds. |
| A memory written on a device without the sync never reaches the server. | The first sync pushes every local entry. |

## Validation

- Server route tests: push, list, delete, search by owner and persona, the embed route, and the answer when the embedder is down.
- Embedder tests: the prefixes, the 256-dimension cut, and the normalization. A real model check runs by hand, because CI does not download the model.
- Client unit tests: the field mapping of entries, the merge of server results with local changes, the fallback by time and by error, and the prompt part.
- Client browser test: a recalled part reaches the newest user turn and does not reach the history.
- A recall check by hand with the owner's Japanese memories: questions that share no words with the entry, for example 「好きな食べ物は？」 for an entry about ramen.

## Open work

- Choose the limits of the memory feature with real data: documents, bytes, and history.
- Decide when the index can leave the system prompt.
- Measure the delay of recall on the owner's PC. A check in step M1 took about 130 ms for one query on the CPU, after a model load of about 10 seconds.
