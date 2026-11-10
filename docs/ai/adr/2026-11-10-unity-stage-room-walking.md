# Walking in a Unity room

Status: accepted

Japanese version: [2026-11-10-unity-stage-room-walking.ja-JP.md](2026-11-10-unity-stage-room-walking.ja-JP.md)

## Context

The Unity stage can show the character in a room. [The ADR of the Unity stage](2026-11-06-unity-stage-sidecar.md) describes this prototype in "Room state". The character stands at one stand point and does not move from it.

The owner wants the character to live in the room:

- When nobody talks with her, she walks through the room and stops at places for a while.
- When the owner talks with her, she stops, turns to the owner, and talks.
- In a later step, she goes to a monitor of the room for game commentary. This ADR does not cover that step.

These facts of the code set the limits of the design:

- `CharacterDriver` mixes one idle clip with gestures. The host sends the idle as a `.vrma` file. The repository has no walk clip.
- A clip gives the move of the hips from its first frame, in `StagePose.HipsX`, `HipsY`, and `HipsZ`.
- `Stage.vue` knows when AIRI thinks (`presenceBubble.thinking`) and when it speaks (`nowSpeaking`). The Unity stage receives neither of these states.
- The Unity project has no AI module, so it has no NavMesh.
- In a VRChat world, the walls and the floors have colliders. The furniture often has none. The room import adds temporary colliders to furniture only for its search of a stand point.
- UniVRM v0.131.4 has `VrmAnimationExporter`. This class writes `.vrma` files from bone rotations, frame by frame.

## Decision

This ADR adds step W1: a walk through the room, a turn to the owner, and a camera that follows. Each part stays off until a player argument or an environment variable turns it on, as the other prototypes of the stage do.

### The walkable area

The room import bakes a NavMesh with the AI Navigation package 2.0 (`com.unity.ai.navigation`), a package of Unity.

- The import adds a `NavMeshSurface` to a new object in the room scene. The surface collects the render meshes, so the furniture is part of the bake.
- The agent of the bake has a radius of 0.25 m and a height of 1.7 m. So the NavMesh has no area under a table or a low shelf.
- The import saves the `NavMeshData` as an asset next to the scene. The scene bundle then carries the data, and the surface adds it to the NavMesh when the room scene loads.
- `StageRoom` uses the type `NavMeshSurface` in its code. So the build of the player keeps this type, although no scene of the player has a surface.

### Open doors

The doors of a world are closed meshes, so a closed door cuts its room out of the NavMesh. In 2LDK, closed doors cut off a washroom, two rooms, and the balcony. The owner chose to open them, also the balcony.

- The import finds doors by name: `door`, `ドア`, `扉`, or `戸`, but not `frame` or `枠`. Doors that touch each other are one group, for example the panels of a sliding door.
- For each group, the import hides the group, bakes, and measures the floor that the stand point reaches. The group stays hidden only when it adds at least 1.5 m². So a closet, an open door, and the front door stay as they are.
- A new room can show a door further in. So the search runs at most three rounds.
- `room.json` lists the open doors in `openDoors`. An earlier list stays through the next import, so the owner can edit it once.
- A hidden door does not swing or slide. The doorway is empty. The baked light and the reflections still hold the closed door.

The first test used the side of each door: reachable floor on one side, and floor that the stand point does not reach on the other. The panels of a sliding door and closets on the back of a room broke this test. So the import measures the floor that each group adds.

| Option | What it does | Result |
| --- | --- | --- |
| **AI Navigation 2.0** | `NavMeshSurface` bakes in the Editor. The package of Unity keeps the data and adds it at load. | Chosen. It is the usual way of Unity, and the Editor shows the walkable area for a check. |
| The AI module only | `NavMeshBuilder` bakes in the Editor. An AIRI component keeps the data. | No new package, but more AIRI code, and no view of the walkable area in the Editor. |
| A grid of AIRI | A path search on the grid of the stand point search. | No AI of Unity, but paths have corners, and the smoothing is AIRI code. |

### The walk clip

The walk comes from the Universal Animation Library of Quaternius, under CC0.

- The owner downloads the pack. An Editor tool of AIRI plays its walk clip on a humanoid and writes `walk.vrma` through `VrmAnimationExporter`.
- CC0 allows a copy in the repository. So `walk.vrma` goes into the Unity project, and the player carries it. This ADR names the source.
- Only the Unity stage walks. So the clip stays in the Unity project, and the protocol gets no message for it.
- The clip plays in place. The driver drops `HipsX` and `HipsZ` of the walk clip, and keeps `HipsY` for the up and down move.

| Option | License | In Git | Result |
| --- | --- | --- | --- |
| **Quaternius, Universal Animation Library** | CC0 | Yes | Chosen. The free tier has about 60 to 70% of the pack. The owner makes sure that it has a walk. |
| A walk from BOOTH | Redistribution forbidden | No, only local copies | A purchase of the owner. |
| Mixamo | Standalone files forbidden | No, only local copies | Needs an Adobe account. |
| A procedural walk of AIRI | No limit | Yes | No file, but it looks the least natural. |

### Locomotion

A new class `WanderPlan` in `Core` decides where the character goes. It has no Unity reference, so `dotnet` tests it.

- `WanderPlan` has three states: Rest, Walk, and Attend.
- Rest lasts a random time from 6 to 20 seconds. Then the plan selects a new destination.
- A destination is a point of the NavMesh on the floor of the stand point, at least 2 m away. It is also at least 0.5 m from each edge, so she does not stop with her face at a wall.
- Walk ends at the destination, or after a time limit. At the end of a walk, she turns to the most open direction.
- Attend starts when the host asks for the attention of the viewer. It ends when the host releases it. Then Rest starts again.

The Stage side moves the character with a `NavMeshAgent`:

- The avatars move under a new transform, a child of `StageRoot`. The agent moves this transform.
- The speed is 0.8 m/s. The weight of the walk clip against the idle clip follows the speed of the agent.
- The walk clip plays faster or slower with the speed of the agent, so the feet slide less.
- `--airi-wander` or `AIRI_UNITY_STAGE_WANDER=1` turns this on. Without a room, the argument has no effect.

### The attention of the viewer

The protocol gets one host message, `host.character.attention`, with the payload `{ "target": "viewer" }` or `{ "target": "none" }`.

- Electron sends it when the target changes. A new `running` status of the sidecar sends it again, as it does for the idle.
- The target is `viewer` while AIRI thinks or speaks, and for 15 seconds after that. Then it is `none`.
- On `viewer`, the character stops, and turns her body to the camera of the window in about 0.5 seconds. Her head and her eyes aim at the camera, inside the limits of the neck.
- The procedural offsets of the frame stay on top of this aim, so the breath and the nods continue.

| Option | What it does | Result |
| --- | --- | --- |
| **A new host message** | Electron decides the attention, and Unity only moves. | Chosen. Electron stays the brain, as the ADR of the Unity stage requires. The message is rare, not 30 times each second. |
| Two fields in the frame | `speaking` and `thinking` go in each frame, and Unity decides. | Unity then holds a decision of the brain. |
| A guess in Unity | Unity reads the mouth weights. | No protocol change, but no thinking state, and a silent pause looks like the end of a talk. |

The ADR of the Unity stage puts the gaze at the viewer in step U5. W1 takes one part of it: the gaze at the camera of the window. Step U5 still adds the gaze at the viewer of the display.

### The camera

The camera of the window follows the character.

- The target of the camera follows the center of the avatar in each frame, with smoothing.
- The yaw and the pitch stay fixed in the world while she walks. So the view does not turn with each turn of her body.
- A sphere cast from the target to the camera finds the first wall. The camera then stops in front of the wall, so no wall comes between the camera and the character.
- The box of the room stays as the outer limit.
- The keys 1, 2, and 3, the mouse, and `--airi-camera` keep their functions.

| Option | What it does | Result |
| --- | --- | --- |
| **A follow camera** | The camera keeps its angle, and its target follows her. Walls push it closer. | Chosen. It works in each room without data of the room. |
| A fixed camera | The camera of today. | She walks out of the view. |
| A director | The camera cuts between viewpoints of the room. | It looks better, but each room needs its viewpoints. A later step can add it. |

## Steps

Each step starts after the owner approves its plan.

| Step | Content | Done when |
| --- | --- | --- |
| W1-0 | This ADR | The owner accepts it. |
| W1-1 | The NavMesh in the room import, and its load in the player | In 2LDK, the player finds a path from the stand point to at least 18 of 20 random points. |
| W1-2 | `walk.vrma`, the walk layer of the driver, `WanderPlan` with tests, and the agent | In captures over 60 seconds, she walks to new places and does not enter furniture or walls. |
| W1-3 | `host.character.attention` in the protocol, Electron, and Unity, with tests on both sides | A test message turns her to the camera, and a chat in the app does the same. |
| W1-4 | The follow camera with the sphere cast, with tests of the math in `Core` | In captures, no wall comes between the camera and the character. |

## What this design does not do

- No places with a meaning, for example a monitor, a sofa, or a bed. She does not sit. A later ADR adds these, with places in `room.json`.
- No game commentary at a monitor of the room.
- No walk in the three.js stage.
- No stairs. The destinations stay on the floor of the stand point.
- No doors that open and close. The import opens each door that cuts off floor, once, and the door stays open.
- No avoidance of objects that move, because nothing else moves in the room.
- No attention from the microphone. W1 reads only the thinking state and the speaking state.

## Risks

| Risk | Result | Action |
| --- | --- | --- |
| The free tier of the Quaternius pack has no walk clip. | W1-2 has no clip. | The owner checks the download first. The other sources of the table stay as options. |
| The feet slide, or the steps look wrong. | The walk looks unnatural. | The clip speed follows the agent speed. Check by eye in captures, also on PMX models. |
| The build of the player removes `NavMeshSurface`. | The NavMesh does not load. | `StageRoom` uses the type. Check the log of the player in W1-1. |
| The bake of a world gives gaps in the NavMesh. | Some destinations cannot be reached. | The plan selects only reachable points. W1-1 measures the share. |
| The camera shakes in a narrow corridor. | An unsteady view. | Smooth the camera, and check in captures. |
| A PMX model walks differently from a VRM model. | Wrong legs on PMX models. | The repository has no PMX model. Check with the models of the owner. |

## Sources

- [Universal Animation Library, Quaternius](https://quaternius.com/packs/universalanimationlibrary.html)
- [AI Navigation 2.0 changelog](https://docs.unity3d.com/Packages/com.unity.ai.navigation@2.0/changelog/CHANGELOG.html)
- [Class NavMeshSurface](https://docs.unity3d.com/Packages/com.unity.ai.navigation@2.0/api/Unity.AI.Navigation.NavMeshSurface.html)
- [VRM Animation](https://vrm.dev/en/vrma/)
