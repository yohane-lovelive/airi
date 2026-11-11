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
- Captures of each open doorway of 2LDK from both sides found one trace: the half-open `Door.011` left its shadow on the floor. The other four doorways showed none. Only a new bake of the light removes such a shadow.

The first test used the side of each door: reachable floor on one side, and floor that the stand point does not reach on the other. The panels of a sliding door and closets on the back of a room broke this test. So the import measures the floor that each group adds.

| Option | What it does | Result |
| --- | --- | --- |
| **AI Navigation 2.0** | `NavMeshSurface` bakes in the Editor. The package of Unity keeps the data and adds it at load. | Chosen. It is the usual way of Unity, and the Editor shows the walkable area for a check. |
| The AI module only | `NavMeshBuilder` bakes in the Editor. An AIRI component keeps the data. | No new package, but more AIRI code, and no view of the walkable area in the Editor. |
| A grid of AIRI | A path search on the grid of the stand point search. | No AI of Unity, but paths have corners, and the smoothing is AIRI code. |

### The walk clip

The walk comes from the Universal Animation Library of Quaternius, under CC0.

- The owner downloads the pack. An Editor tool of AIRI plays its walk clip on a humanoid and writes `walk.vrma` through `VrmAnimationExporter`.
- `pnpm run import:motion` runs this tool. It converts the clip `Walk_Loop` from the FBX files in `.cache/motions/<name>/` to `Assets/StreamingAssets/AiriMotions/walk.vrma`.
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
- The agent does not turn her. The Stage side turns her body to the next corner of the path, at 240 degrees each second.
- Her speed follows her facing. So at the start of a walk, she turns first, and she does not slide to the side.
- The speed is 0.8 m/s. The weight of the walk clip against the idle clip follows the speed of the agent.
- The walk clip plays faster or slower with the speed of the agent, so the feet slide less.
- `--airi-wander` or `AIRI_UNITY_STAGE_WANDER=1` turns this on. Without a room, the argument has no effect.

### The attention of the viewer

The protocol gets one host message, `host.character.attention`, with the payload `{ "target": "viewer" }` or `{ "target": "none" }`.

- Electron sends it when the target changes. A new `running` status of the sidecar sends it again, as it does for the idle.
- The target is `viewer` while AIRI thinks or speaks, and for 15 seconds after that. Then it is `none`.
- On `viewer`, the character stops, and turns her body to the camera of the window in about 0.5 seconds. Her head and her eyes aim at the camera, inside the limits of the neck.
- The procedural offsets of the frame stay on top of this aim, so the breath and the nods continue.

W1-3 builds it this way:

- `useStageSidecarAttention` in `stage-ui` decides the target in the renderer. The bridge of the desktop app keeps the last target, and a new `running` status sends `viewer` again.
- `GazeAim` in `Core` turns the neck and the head up to 50 degrees to the side, and 25 degrees up or down. The neck takes 40% of this turn.
- The eyes take the rest of the angle, up to 12 degrees to the side and 8 degrees up or down. The aim fades in and out in 0.3 seconds.
- The body turns at 360 degrees each second, so a half turn takes 0.5 seconds. The head reaches the camera first.
- The sidecar acts on the message only with `--airi-wander`, as on each other part of W1. Without the argument, the stage looks as before.
- In the app, a chat in 2LDK turned her to the camera while AIRI thought. After the reply, the attention ended, and she walked again.

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

W1-2 takes one part of this early: the target follows her, without smoothing. Without it, she walks out of the view. W1-4 adds the smoothing and the sphere cast.

W1-4 builds the rest this way:

- `StageCameraFollow` in `Core` smooths the target with a time constant of 0.25 seconds. A wall pulls the camera in at once, and the camera returns in 0.5 seconds.
- The sphere has a radius of 0.15 m. The cast also hits the back of a face, because a wall of a world can be one plane. The colliders of an MMD model are not walls.
- A wall does not pull the camera nearer than 0.3 m to its target.
- A world often gives no collider to a door. So when the room loads, each door that shows gets a box from the bounds of its renderer.
- These rules work in each room, also without `--airi-wander`, because the mouse can also turn the camera behind a wall. Without a room, the camera is as before.

The captures showed only her hips and hands when she stood at a wall, because no place in front of the wall shows her whole body. So W1-4 also moves the camera around her. This changes the fixed yaw above:

- Below 60% of its framed distance, the camera tests turns of up to 120 degrees, in steps of 20 degrees.
- It takes the middle of a span of turns with at least 90% of the distance. A wide span wins, and then the span nearest to the camera.
- A turn of up to 45 degrees swings, at most 90 degrees each second. A larger turn cuts, as between two cameras. A swing through a corridor faces its walls.
- When the angle of the owner has room again for 1 second, the camera returns to it.
- Furniture also counts. When the room loads, each piece of furniture on the floor gets a box on the physics layer `AiriFurniture`. For each turn, lines from the camera to five points of her body count the points that a box hides.
- One hidden point, often an ankle behind a low table, does not move the camera. Two or more make the side cramped, as a near wall does. The wall cast ignores these boxes, so the camera never stops in front of a sofa.
- In eight walks of 75 seconds in 2LDK, this cut the time with two or more hidden points from 2.6% to 0.6%. The time with a near camera did not grow.

In the last captures of W1-4, two VRM samples walked for 70 seconds each in 2LDK. No wall stood between the camera and her. A sofa or a table can still stand in front of her, because furniture has no collider.

| Option | What it does | Result |
| --- | --- | --- |
| **A follow camera** | The camera keeps its angle, and its target follows her. Walls push it closer, or move it around her. | Chosen. It works in each room without data of the room. |
| A fixed camera | The camera of today. | She walks out of the view. |
| A director | The camera cuts between viewpoints of the room. | It looks better, but each room needs its viewpoints. A later step can add it. |

## Steps

Each step starts after the owner approves its plan.

| Step | Content | Done when |
| --- | --- | --- |
| W1-0 | This ADR | The owner accepts it. |
| W1-1 | The NavMesh in the room import, and its load in the player | In 2LDK, the player finds a path from the stand point to at least 18 of 20 random points. |
| W1-2 | `walk.vrma`, the walk layer of the driver, `WanderPlan` with tests, the agent, and a camera target that follows her | In captures over 60 seconds, she walks to new places and does not enter furniture or walls. |
| W1-3 | `host.character.attention` in the protocol, Electron, and Unity, with tests on both sides | A test message turns her to the camera, and a chat in the app does the same. |
| W1-4 | The smoothing, the sphere cast, and the move around walls of the follow camera, with tests of the math in `Core` | In captures, no wall comes between the camera and the character. |

## What this design does not do

- No places with a meaning, for example a monitor, a sofa, or a bed. She does not sit. A later ADR adds these, with places in `room.json`.
- No game commentary at a monitor of the room.
- No walk in the three.js stage.
- No stairs. The destinations stay on the floor of the stand point.
- No doors that open and close. The import opens each door that cuts off floor, once, and the door stays open.
- No avoidance of objects that move, because nothing else moves in the room.
- No furniture stops the camera. Only walls, floors, and doors do. Furniture only makes the camera prefer a side where her body shows.
- No attention from the microphone. W1 reads only the thinking state and the speaking state.

## Risks

| Risk | Result | Action |
| --- | --- | --- |
| The free tier of the Quaternius pack has no walk clip. | W1-2 has no clip. | The owner checks the download first. The other sources of the table stay as options. |
| The feet slide, or the steps look wrong. | The walk looks unnatural. | The clip speed follows the agent speed. In captures of a VRM sample in W1-2, a planted shoe slid by about 8% of the walk speed. Check PMX models too. Later the stride took 92% of 1.30 / 0.90. A log of the foot bones then gave planted feet within 2% of the walk speed. |
| The build of the player removes `NavMeshSurface`. | The NavMesh does not load. | `StageRoom` uses the type. Check the log of the player in W1-1. |
| The bake of a world gives gaps in the NavMesh. | Some destinations cannot be reached. | The plan selects only reachable points. W1-1 measures the share. |
| The camera shakes in a narrow corridor. | An unsteady view. | Smooth the camera, and check in captures. In W1-4, a corridor gives a cut, and the captures showed no shake. |
| A PMX model walks differently from a VRM model. | Wrong legs on PMX models. | The repository has no PMX model. Check with the models of the owner. After W1-4, two PMX models of the owner walked through 2LDK with correct legs. They turned to the camera, and their hair and skirts stayed calm. The image measure of the foot slip did not work on them, and by eye their feet did not slide. |

## Sources

- [Universal Animation Library, Quaternius](https://quaternius.com/packs/universalanimationlibrary.html)
- [AI Navigation 2.0 changelog](https://docs.unity3d.com/Packages/com.unity.ai.navigation@2.0/changelog/CHANGELOG.html)
- [Class NavMeshSurface](https://docs.unity3d.com/Packages/com.unity.ai.navigation@2.0/api/Unity.AI.Navigation.NavMeshSurface.html)
- [VRM Animation](https://vrm.dev/en/vrma/)
