# Places and game commentary in a Unity room

Status: accepted

Japanese version: [2026-11-11-unity-stage-room-places-commentary.ja-JP.md](2026-11-11-unity-stage-room-places-commentary.ja-JP.md)

## Context

After step W1 of [the walking ADR](2026-11-10-unity-stage-room-walking.md), the character walks through a room, turns to the viewer, and a camera follows her. That ADR left places with a meaning and game commentary to a later ADR.

The owner wants two more things:

- Places with a meaning. She stands in front of the monitor, and she sits on a chair or a sofa.
- Game commentary at the monitor of the room. She sits at the desk, watches the game, and talks about it.

These facts of the code and of the room set the limits of the design:

- `room.json` has one stand point, a facing, a box, and `openDoors`. It has no places.
- In 2LDK, the desk `Table.001` holds the monitor `モニター.002` and a PC. The black gaming chair `Chair.006` stands in front of the desk.
- The screen of `モニター.002` uses the material `WallPaper`, a picture of a desktop.
- 2LDK also has a sofa set, a bed, and two TVs. Most furniture has no collider.
- The room uses static batching, so the furniture cannot move. The chair stays where the world puts it.
- The pack `UAL1_Standard.fbx` of Quaternius has `Sitting_Enter`, `Sitting_Idle_Loop`, `Sitting_Talking_Loop`, and `Sitting_Exit`, under CC0. It has no clip of lying down.
- AIRI already has commentary, from step 3-5a of [the perception ADR](2026-10-28-autonomous-character-perception-and-missions.md). The missions store of `stage-ui` gives the running commentary through `commentaryAt(now)`.
- During a commentary, perception captures the front window of the target app. It takes 2 frames each second, as JPEG of at most 1280 pixels. The frames stay in memory.
- The protocol of the sidecar carries JSON text only. The socket client of Unity reads each message as UTF-8 text.
- `useStageSidecarAttention` sends `viewer` while AIRI thinks or speaks, and for 15 seconds after that.

## Decision

This ADR adds step W2: places in the room, sitting, and an activity from Electron. It also adds the game on the monitor of the room, and a camera for a place. Each part acts only with `--airi-wander`, as each part of W1 does.

### The split between the brain and the room

Electron says what the character does. Unity decides where in the room she does it.

| Option | What it does | Result |
| --- | --- | --- |
| **An activity from Electron** | Electron sends `watching-screen`. Unity selects a place of the room for it. | Chosen. Electron knows nothing of the room, as in W1. |
| A place from Electron | Electron sends the name of a place. | The brain then needs the places of each room. |
| A decision in Unity | Unity reads the screen frames and decides to watch them. | Unity then holds a decision of the brain. |

### Places in the room file

The room import finds places from the names of objects, and it writes them in the new field `places` of `room.json`.

- A place has a `name`, a `role`, a `stand` point, and a `facing`. A place with a `seat` point also lets her sit.
- The role `screen` names a monitor or a TV. Such a place also names its screen surface: the object and the name of its material.
- The role `seat` names a chair, a sofa, a bench, or a bed. The pack has no clip of lying down, so a bed is a seat at its edge.
- The import finds screens by names, for example `monitor`, `display`, `tv`, `モニター`, `ディスプレイ`, and `テレビ`.
- The import finds seats by names, for example `chair`, `sofa`, `couch`, `bench`, `bed`, `椅子`, `イス`, `ソファ`, and `ベッド`.
- A screen with a seat within 1.5 m in front of it makes one place with that seat. Her facing then goes from the seat to the screen.
- A screen without a seat makes a place where she stands in front of the screen. This is the stand at the monitor that the owner asked for.
- Rays from above find the seat surface, 0.3 to 0.7 m above the floor. The seat point lies on this surface.
- The stand point is the point of the NavMesh nearest to the seat point, at most 1 m away. The stand point of the room must reach it.
- A seat without a screen faces from its seat point to its stand point, that is, to the open floor.
- The import puts a screen place with a seat first. The owner can change the order.
- An earlier `places` list stays through the next import, as `openDoors` does. So the owner can edit it once. To find the places again, delete the field.
- A room file without `places` has no places. A room imported before W2-1 gets its places from a new import.

W2-1 builds it this way. It changes three values above: the height of a seat, the meaning of the seat point, and the distance of the stand point.

- A seat is a group of parts with seat names that touch, for example the cushions and the backs of a sofa.
- Names with `table`, `bedside`, `light`, `lamp`, `shelf`, `テーブル`, `机`, `ライト`, `ランプ`, or `棚` are no seats.
- A screen is a part with a screen name and a flat, upright surface of at least 0.1 m².
- Names with `light`, `lamp`, `stand`, `board`, `rack`, `shelf`, `arm`, `frame`, `ライト`, `ランプ`, `台`, `棚`, or `枠` are no screens.
- A static batch hides the mesh of a screen in the player. So `room.json` also gives the center, the facing, the width, and the height of the screen.
- Rays down on a grid of 2.5 cm give the heights of a seat. Its surface is a flat area 0.3 to 0.65 m above the floor that holds a circle of 0.3 m.
- The arms of the gaming chair of 2LDK leave 0.4 m between them, so a circle of 0.4 m did not fit.
- Parts at least 0.15 m above the seat, within 0.8 m of its middle, are its back. Their directions add up, so two arms cancel.
- A seat with a back faces away from it. A seat without a back faces the nearest floor that she reaches.
- The rounded edges of cushions split a sofa into one area for each cushion. An area with a back wins over a larger area without one.
- The seat point is the middle of the front edge of the seat, where her knees go. W2-2 puts her hips behind it by about the length of her thighs.
- The stand point is the point of the NavMesh nearest to the seat point, at most 1.2 m away. The front edge of a chair at a table lies under the table.
- A screen without a seat gets a stand point in front of it. Its distance is the width of the screen, and at least 0.8 m.
- The bake of the NavMesh makes the parts of seats not walkable. The modifiers of the bake leave the scene before the bundle.
- Before W2-1, the frame of the bed of 2LDK was a step onto the bed. So the stand point of the room reached the top of the bed. After W2-1, no part of the NavMesh lies 0.25 to 0.8 m above the floor.
- In 2LDK, the import found 14 places: the desk with `モニター.002` and `Chair.006`, three TVs to watch standing, the bed, eight chairs, and the sofa.
- The seat of `Chair.006` is 0.52 m high. mr009 has no object with such a name, so it has no places.
- A second import kept an edit of the facing of the sofa.

| Option | What it does | Result |
| --- | --- | --- |
| **Names, and edits in `room.json`** | The import finds places from names. The owner corrects the file. | Chosen. Many worlds name their furniture, and the owner fixes the rest once. |
| Edits only | The owner writes each place by hand. | Exact, but each room needs work before its first use. |
| Shapes | The import finds seats from the shapes of meshes. | No names needed, but much code, and many false seats. |

### Sitting

The motion import converts four more clips of the same pack. CC0 allows copies in the repository, so the player carries them.

- `Sitting_Enter`, `Sitting_Idle_Loop`, `Sitting_Talking_Loop`, and `Sitting_Exit` become `sit-enter.vrma`, `sit-idle.vrma`, `sit-talk.vrma`, and `sit-exit.vrma` in `AiriMotions`.
- She walks to the stand point of the place.
- She then steps off the NavMesh to the spot in front of the seat, and turns to the facing of the place. The enter clip plays there.
- The seat point lies off the NavMesh, because the chair is part of the bake. So the agent lets go of her while she sits.
- The driver keeps the whole move of the hips of these clips. A sit clip moves the hips down and back while the feet stay.
- Models differ in the length of their legs. So the stage puts her hips on the seat, behind the seat point by the length of her thighs.
- She sits with the idle loop. While the attention is `viewer`, the talk loop takes its place.
- To leave, the exit clip plays, and she steps back to the stand point. Then the agent takes her again.

While she sits, the attention of the viewer does not end the sitting:

- Her body does not turn. Her spine takes 30% of the turn, up to 30 degrees, and her chest turns with it.
- Her neck, her head, and her eyes take the rest, inside the limits of `GazeAim`. So her face turns up to about 90 degrees from her facing.
- The procedural offsets of the frame stay on top, as they do while she stands.

In a walk without an activity, some rests take a place:

- One rest in three goes to a free place, when the room has one.
- She sits when the place has a seat. Otherwise she stands at the stand point and faces the facing of the place.
- A rest on a seat lasts 20 to 60 seconds, because a short sit looks restless.

W2-2 builds it this way. It changes three points above: the move of the hips, the way to the seat, and the bone that turns.

- In the sit loop of the pack, the hips lie 0.41 hip heights lower than in the T-pose. They also lie 0.42 hip heights behind it.
- The hips keep this move back. Without it, the root must move in its place, and her feet slide about 0.5 m.
- So she steps at 0.5 m/s to the spot of her feet, and she sits there with no slide. The step leaves the NavMesh.
- The spine turns, not the chest. VRM 1.0 does not require a chest bone, and the chest turns with the spine.
- A sit loop moves its legs little. So the check of the motion import takes the muscle that moves the most, not the left thigh.
- `SeatMotion` plays the sit clips over the walk and under the gestures. A change of clip fades from the last pose in 0.25 seconds.
- `StageSit` fits a seat. Her knees go 0.08 m in front of the seat point, and her hip joints 0.12 hip heights above the seat.
- With her knees on the edge, her calves went into the front of the sofa of 2LDK. The margin of 0.08 m keeps them in front.
- Short legs let her feet hang. The root rises or sinks as far as she sat down.
- Long legs sink her feet by at most 0.02 m, about one sole. Then her hips stay above the seat for the rest.
- On the low bed of 2LDK, a sink of 0.05 m hid her shoes in the floor. Her hips now stay 0.07 m above the bed.
- While she sits, the furniture box around her seat turns off. Her body is inside it, so the camera saw her as hidden from each side.
- Her hips move down and back as she sits. The target of the camera follows this move, or a face view loses her.
- A clip of the whole body does not play while she sits. An upper-body gesture plays over the sit.
- A new model stands her up at once at the stand point.
- `--airi-place=<name>`, or `AIRI_UNITY_STAGE_PLACE`, sends her to a place after her first rest. It is for checks.
- In 2LDK, AvatarSample_A sat at the desk, on the sofa, and on the bed. A PMX model of the owner sat at the desk and on the sofa.
- Each time, her hips rested on the seat, and she got up and walked on. The talk loop and the turn of the spine showed during an attention.
- The sofa of 2LDK faces 74 degrees, because its pillows pull the sum of its back aside. An edit to 90 in `room.json` fixes it.
- The cameras of W1 do not stop at furniture without a collider. At the desk, a close camera can stand in the desk or the PC. W2-5 adds the camera at a place.

### The activity

The protocol gets one host message, `host.character.activity`, with the payload `{ "activity": "watching-screen" }` or `{ "activity": "none" }`.

- The activity is `watching-screen` while a commentary mission runs. Otherwise it is `none`.
- `useStageSidecarAttention` of `stage-ui` decides it from `commentaryAt` of the missions store, together with the attention.
- Electron sends it when it changes. A new `running` status of the sidecar sends it again, as it does for the idle and the attention.
- On `watching-screen`, Unity takes the first place with the role `screen`. She walks there, sits or stands, and watches the screen.
- On `none`, she stands up, and the walk through the room continues.
- During the activity, the rests and the random destinations stop.
- While she goes to the place, a `viewer` attention turns only her head and her eyes. She does not stop.
- A room without a screen place ignores the activity, and the player log says so.

| Option | What it does | Result |
| --- | --- | --- |
| **A new host message** | `host.character.activity` says what she does. The attention still says whom she looks at. | Chosen. Each message has one meaning, and both are rare. |
| A field in the attention | `host.character.attention` also carries the activity. | One message less, but one message with two meanings. |

### The gaze during commentary

During the activity, she watches the game, and she turns to the camera only for her lines.

- While the attention is `none`, her head and her eyes aim at the center of the screen of the place.
- During a commentary, the renderer gives `viewer` only while AIRI speaks, and for 2 seconds after that.
- Thinking does not count during a commentary. Most of its turns start from the screen, not from the owner.
- This changes the release of 15 seconds of W1-3, only during a commentary. Outside a commentary, the attention stays as before.

W2-3 builds it this way. It changes one point above: one composable decides the activity and the attention.

- The rule of the attention depends on the activity. For example, a release of 15 seconds becomes a release of 2 seconds when a commentary starts.
- So `useStageSidecarAttention` decides both. Two composables must share this state.
- A commentary ends at its time limit, so `Stage.vue` checks `commentaryAt` each second.
- A start of the activity ends a rest, a walk, or an attention at once, and she walks to the screen place.
- From another seat, she gets up first. From a step to another seat, she steps back first.
- At a seat of the screen place, she sits as long as the activity goes on. At a screen without a seat, she stands as long.
- The end of the activity gets her up. A walk to the screen stops, and a stand at a screen ends its rest.
- During the activity, her body does not turn for the viewer. Her spine takes its share of the turn, as while she sits.
- `WanderPlan.LooksAtScreen` tells when she watches. She then sits or stands at the screen place, and the attention is `none`.
- In 2LDK, a test message sent her to the desk at once. She sat, and watched the monitor.
- A `viewer` turned her face to the camera over her shoulder, and a release turned it back to the monitor.
- She sat 52 seconds, until the end of the activity. Then she got up at once and walked on.
- In the app, the owner asked for a commentary, with a PMX model of the owner. She walked to the desk and sat at the monitor.
- For each line, her face turned to the camera. After each line, it turned back to the monitor. When the commentary ended, she got up and walked on.
- The owner stopped a commentary and started a new one. So `none` and `watching-screen` came within 9 seconds, and she turned back to the desk.

### The game on the monitor of the room

The protocol gets one more host message, `host.room.screen`, with the payload `{ "image": "<JPEG in base64>" }`.

- A second sampler takes frames from the video of the commentary capture. It takes 8 frames each second, at most 960 pixels on the long side, as JPEG of quality 0.7.
- It takes a frame only when perception takes frames of the target window. So the window is in front, and no exclusion of perception matches.
- Electron sends the frames only while the activity is `watching-screen`.
- The frames stay in memory. Only the local player gets them, through the socket on localhost. Neither side writes them to the disk.
- Unity decodes each JPEG into one texture. An unlit material shows it on the screen surface of the place, with black bars for another shape.
- When no frame comes for 3 seconds, or the activity ends, the screen shows its own material again.

The source of the frames:

| Option | What it does | Result |
| --- | --- | --- |
| **A sampler of the commentary capture, 8 frames each second** | It reads the video that perception already captures. | Chosen. The privacy rules of perception hold, and the motion looks smooth on a small screen. |
| The frames of perception | It sends the 2 frames each second of the frame ring. | No new sampler, but the game looks like a slide show. |
| A window capture in Unity, for example uWindowCapture | A native plugin captures the window in Unity. | Smooth, but a new native plugin, and Unity selects the window outside the exclusions of AIRI. |

The transport of the frames:

| Option | What it does | Result |
| --- | --- | --- |
| **Base64 in a JSON message** | The frame goes in a host message, as the other messages do. | Chosen. One format for each message, and the fixtures test it. About 0.7 MB each second is small on localhost. |
| Binary messages | The socket carries the raw JPEG. | A third less data, but a second message format, and new paths in the socket code of both sides. |
| Files on the disk | Electron writes each frame, as it writes the idle clip. | Images of the screen on the disk break the rule of perception. |

### The camera at a place

While she is at a place with a screen, the camera shows both her and the screen.

- The camera stands behind her and to one side, about 125 degrees from her facing, and a little above her head.
- Its target lies between her head and the center of the screen. Its distance holds both in the view.
- The side with more room wins. The wall cast and the furniture boxes of W1-4 measure the room.
- When she speaks, her face turns up to about 90 degrees. So the camera sees her face from the side.
- A drag of the mouse still turns the camera. When she leaves the place, the camera returns to the angle from before.
- At a seat without a screen, the camera stays as in W1.

| Option | What it does | Result |
| --- | --- | --- |
| **An angle behind her side** | The camera shows her and the game. For a line, she turns her face toward it. | Chosen. The view looks like a stream of a player. |
| The follow camera of W1 | No new code. | The screen often stays out of the view, or her back hides it. |
| A cut to her face for each line | A second camera in front of her shows her while she speaks. | Her face shows well, but a cut each 15 to 45 seconds can feel restless. A later step can add it. |

## Steps

Each step starts after the owner approves its plan.

| Step | Content | Done when |
| --- | --- | --- |
| W2-0 | This ADR | The owner accepts it. |
| W2-1 | `places` in the room import and in `room.json`, with tests of the room file in `Core` | In 2LDK, the import finds the desk with `モニター.002` and `Chair.006`, and at least one sofa seat. The stand point of the room reaches each stand point. A second import keeps an edit. |
| W2-2 | The four sit clips, the sit states of the driver and the walker, the turn of the chest, and the rests at places | In captures in 2LDK, she sits on a seat, her hips rest on it, and she gets up and walks again. Check a VRM sample and a PMX model of the owner. |
| W2-3 | `host.character.activity` in the protocol, Electron, and Unity, and the gaze during commentary, with tests on both sides | A test message sends her to the desk, and she sits and watches the screen. A commentary in the app does the same, and her face turns to the camera for each line. |
| W2-4 | `host.room.screen`, the sampler, and the screen material in Unity | During a commentary in the app, the monitor of the room shows the game at about 8 frames each second. When the window leaves the front, the monitor returns to its material within 3 seconds. The player log gives the decode time. |
| W2-5 | The camera at a place, with tests of the math in `Core` | In captures of a commentary in 2LDK, the view shows her and the game, and no wall hides her head or the screen. A drag of the mouse still turns the camera. |

W2-3 and W2-4 add their messages to the protocol table of [the ADR of the Unity stage](2026-11-06-unity-stage-sidecar.md) in the same commit.

## What this design does not do

- No lying down. A bed is a seat at its edge.
- No hands on a keyboard, a mouse, or a gamepad. Her hands do not play the game.
- No furniture that moves. She sits on the chair where the world puts it.
- No sound of the game in the room.
- No activity other than `watching-screen`, for example no sleep and no cooking.
- The monitor shows only the window of a commentary. It does not show the desktop at other times.
- No places in the three.js stage.
- No IK of the feet while she sits.
- No cut to her face for each line.

## Risks

| Risk | Result | Action |
| --- | --- | --- |
| A world names its furniture in another way, for example `Cube.023`. | The import misses a place. | The import log lists each candidate. The owner adds the place in `room.json`. |
| The height or the shape of a seat does not fit the clip. | Her feet float, or her arms pass through the arms of the chair. | The stage sets her hips on the seat point. Check captures with VRM and PMX models. The owner can move the seat point. |
| The chair stands close to the desk. | Her move from the stand point to the seat passes through the chair. | Check captures. The stand point can lie beside the chair. |
| MMD physics ignores the room. | Skirts and hair of a PMX model pass through the chair. | Check captures. Accept a small overlap. |
| The decode of each JPEG runs on the main thread of the player. | The frame rate of the player drops. | Measure the decode time in W2-4. Lower the size or the rate when it is too slow. |
| The UVs of the screen surface do not cover the whole image, or they flip it. | The game shows cut or upside down. | Check in 2LDK in W2-4. As a fallback, the stage puts a quad on the screen surface. |
| The player build strips the unlit shader. | The screen shows pink. | `setup:project` keeps a material of the shader in `Resources`, as for the lilToon looks. |
| A lively commentary has many lines. | She turns her head too often, and she looks restless. | Tune the release of 2 seconds in captures. |

## Sources

- [Universal Animation Library, Quaternius](https://quaternius.com/packs/universalanimationlibrary.html)
- [ImageConversion.LoadImage](https://docs.unity3d.com/ScriptReference/ImageConversion.LoadImage.html)
- [uWindowCapture](https://github.com/hecomi/uWindowCapture)
