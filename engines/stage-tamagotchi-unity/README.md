# `@proj-airi/stage-tamagotchi-unity`

Unity display sidecar for `stage-tamagotchi`. The target is the Sony ELF-MN1 spatial reality display. [The ADR](../../docs/ai/adr/2026-11-06-unity-stage-sidecar.md) has the design and the steps.

## What It Does

- Holds the Unity side of the display sidecar. Electron stays the brain, and Unity only draws.
- Holds `Assets/Airi/Core`, the part with no Unity reference: the protocol, the WebSocket client, the frame conversion, and the logic of the character.
- Tests `Core` through `dotnet`. The tests need no Unity install and no Unity license.

## Current State

Steps U0 to U4 are done. A VRM model or a PMX model that you select in AIRI shows in a Unity window. It plays the idle, the gestures, the expressions, the mouth, the blink, and the procedural layer, and a chat reply with TTS moves it. Step U5 adds the ELF-MN1 output.

The stage cannot show a PMD model, because the MMD loader reads only PMX files. AIRI shows an error for such a model, and the old model stays.

The window also has prototypes: a lilToon look, light presets, a mouse camera, and rooms from local packages. Each one stays off until you turn it on. The Settings page has no control for them.

## Run the Stage

These steps need Unity 6000.3.28f1, with a license in Unity Hub.

Build the player:

```bash
pnpm -F @proj-airi/stage-tamagotchi-unity build:player
```

Set `AIRI_UNITY_STAGE_EXECUTABLE` to `Builds/Windows/airi-unity-stage.exe`, with its absolute path. Then start `pnpm dev:tamagotchi`, and select the Unity Stage button on the model page of Settings.

## Try the Prototypes

The player reads these variables from the environment of AIRI. Set them before you start `pnpm dev:tamagotchi`.

| Variable | Player argument | Effect |
| --- | --- | --- |
| `AIRI_UNITY_STAGE_LOOK=liltoon` | `--airi-look=liltoon` | Replaces the materials of the model with lilToon. |
| `AIRI_UNITY_STAGE_GRADE=backlit`, `live`, or `cinema` | `--airi-grade=...` | Sets the light and the camera effects. |
| `AIRI_UNITY_STAGE_ROOM=<folder>` | `--airi-room=<folder>` | Shows the character in an imported room. |
| `AIRI_UNITY_STAGE_WANDER=1` | `--airi-wander` | Lets the character walk through the room. It needs a room with a NavMesh. |

Move the camera with the mouse in the Unity window:

- Left drag: goes around the character.
- Right drag: moves across the view.
- Wheel: comes closer or goes back.
- Keys 1, 2, and 3: the full body, the upper body, and the face.
- Double click: back to the full body.

The player keeps the last camera for the next start. The argument `--airi-camera=full|upper|face|custom:...` fixes the camera, for example for captures.

## Import a Room

A room is a Unity package of a world, for example a VRChat world from BOOTH. Read its license first. Most such licenses forbid redistribution, so the package and each imported file stay on your PC.

1. Put the package in its own folder, `.cache/rooms/<name>/<file>.unitypackage`, at the root of the repository. The name has only letters, digits, `-`, and `_`.
2. Close the Unity Editor, and run this command. It imports each room folder.

   ```bash
   pnpm -F @proj-airi/stage-tamagotchi-unity import:room
   ```

3. Set `AIRI_UNITY_STAGE_ROOM` to the absolute path of the room folder.

The folder then has `room.bundle` and `room.json`. The import chooses a stand point and a facing. To change them, edit `stand` and `facing` in `room.json`. The next import keeps them.

The import also opens the doors that cut off a room, so the character can walk into it. It hides these doors and lists them in `openDoors` of `room.json`. To open or close another door, edit this list, and import the room again.

The import takes only data files. It removes the scripts of the VRChat SDK, moves the materials to URP, and keeps the baked light. It also bakes the walkable area of the room, a NavMesh, for the walk of the character. The [ADR](../../docs/ai/adr/2026-11-06-unity-stage-sidecar.md) lists each step.

## Convert the Walk Clip

The walk of the character is `Assets/StreamingAssets/AiriMotions/walk.vrma`. It is the clip `Walk_Loop` of the [Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html) by Quaternius. Its license is CC0, so the repository keeps the file.

To convert the clip again, put `UAL1_Standard.fbx` of the pack in `.cache/motions/<name>/`. Close the Unity Editor, and run this command:

```bash
pnpm -F @proj-airi/stage-tamagotchi-unity import:motion
```

The [ADR of the walk](../../docs/ai/adr/2026-11-10-unity-stage-room-walking.md) describes the walk, the paths, and the camera.

## Work in the Editor

1. Open this folder with Unity Hub, and open `Assets/Airi/Scenes/Stage.unity`.
2. Set the variable `AIRI_UNITY_STAGE_ATTACH` to `1`, and start `pnpm dev:tamagotchi`.
3. Select the Unity Stage button on the model page of Settings.
4. Start Play mode.

Play mode can stop and start again while AIRI waits. Close the Editor before you run a command that starts Unity, because one project accepts one Editor.

## Check the Electron Side Without Unity

The script `apps/stage-tamagotchi/scripts/fake-stage-sidecar.mjs` obeys the protocol and prints each message. Use it in place of Play mode, from `apps/stage-tamagotchi`:

```bash
node scripts/fake-stage-sidecar.mjs --attach=<userData>/unity-stage/attach.json
```

## Change the Project Settings

`Assets/Airi/Editor/StageProjectSetup.cs` writes the settings and the scene. Change this file, and run this command. Do not change these settings by hand, because the next run replaces them.

```bash
pnpm -F @proj-airi/stage-tamagotchi-unity setup:project
```

Unity runs only one `-executeMethod` in a batch run, so the setup and the build are two commands.

## When To Use It

- Use it for the Unity scene, the model loading, and the display output.
- Use it when the character must show on a spatial reality display.

## When Not To Use It

- Do not put chat, speech, memory, or settings logic here. These stay in Electron.
- Do not define the protocol here. `packages/stage-shared/src/stage-sidecar` owns it, and `Core` obeys it.
- Do not use it for a transparent desktop mascot. The three.js stage serves the desktop.

## Directory Layout

- `Assets/Airi/Core/`: code with no `UnityEngine` reference. It must compile with C# 9 on .NET Standard 2.1, as in Unity.
- `Assets/Airi/Stage/`: the connection, the VRM and MMD avatars, the `.vrma` clips, the display output, the looks, the rooms, and the walk.
- `Assets/Airi/Editor/`: the project setup, the player build, the room import, and the motion import.
- `Assets/Airi/Looks/Resources/AiriLooks/`: material templates of the lilToon look. `setup:project` writes them.
- `Assets/StreamingAssets/AiriMotions/`: the clips that the player carries, for now only the walk.
- `Assets/LocalRooms/`: the files of imported rooms. Git ignores this folder.
- `Assets/LocalMotions/`: the FBX files of the motion import. Git ignores this folder.
- `tools/run-unity.ps1`: runs Unity in batch mode, also with the Microsoft Store version of Unity Hub.
- `tests/stage-tamagotchi-unity.core/`: compiles `Core` with these limits, outside Unity.
- `tests/stage-tamagotchi-unity.tests/`: the verification host. It reads the fixtures of `stage-sidecar`, also the output of the TypeScript code in `character-fixtures`.
- `Packages/com.yohawing.mmd-loader/`: a vendored package with patches. [`docs/vendor-patches.md`](docs/vendor-patches.md) lists them.

`apps/stage-tamagotchi/src/main/services/airi/unity-stage/player.integration.test.ts` tests a real player. It runs when `AIRI_UNITY_STAGE_PLAYER` names one. Each test also expects the exit code 0 from the player. The test of a real MMD model also needs `AIRI_UNITY_STAGE_PMX_SAMPLE`, with the folder of an unpacked model. The repository has no MMD model, because MMD models have terms of their own.

## Commands

These commands need the .NET 10 SDK.

```bash
pnpm -F @proj-airi/stage-tamagotchi-unity typecheck
```

```bash
pnpm -F @proj-airi/stage-tamagotchi-unity test
```

From this folder, this command checks the format:

```bash
dotnet format stage-tamagotchi-unity.slnx --verify-no-changes
```

## Dependencies

`Core` uses Newtonsoft.Json. `dotnet` gets it from NuGet, and Unity gets it from the `com.unity.nuget.newtonsoft-json` package. `Stage` uses UniVRM v0.131.4, lilToon 2.4.1, AI Navigation 2.0.16, and URP, which `Packages/manifest.json` pins, and the vendored unity-mmd-loader v0.5.1.

The stage makes lilToon materials at runtime. So `setup:project` sets `LILTOON_DISABLE_OPTIMIZATION`, and a build keeps each feature of lilToon.

MMD files use Shift_JIS, and a Mono player has no tables for it. So `StageBuild` copies `I18N.dll` and `I18N.CJK.dll` from the Editor to each player.

A `dotnet` build cannot see a name that collides with `UnityEngine`, for example `HumanPose`. So build the player after a change of `Core`.

Sony does not give its plugin under the license of this repository, so `.gitignore` excludes `Assets/SRDisplayUnityPlugin/`. Model files and rooms also stay out of Git.
