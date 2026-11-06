# `@proj-airi/stage-tamagotchi-unity`

Unity display sidecar for `stage-tamagotchi`. The target is the Sony ELF-MN1 spatial reality display. [The ADR](../../docs/ai/adr/2026-11-06-unity-stage-sidecar.md) has the design and the steps.

## What It Does

- Holds the Unity side of the display sidecar. Electron stays the brain, and Unity only draws.
- Holds `Assets/Airi/Core`, the part with no Unity reference: the protocol, the WebSocket client, and the frame conversion.
- Tests `Core` through `dotnet`. The tests need no Unity install and no Unity license.

## Current State

Steps U0, U1, U2, and U4 are done. A VRM model or a PMX model that you select in AIRI shows in a Unity window, with the physics of the PMX model. The character stands in its rest pose, because step U3 adds the idle, the expressions, the gestures, and the mouth.

The stage cannot show a PMD model, because the MMD loader reads only PMX files. AIRI shows an error for such a model, and the old model stays.

## Run the Stage

These steps need Unity 6000.3.28f1, with a license in Unity Hub.

Build the player:

```bash
pnpm -F @proj-airi/stage-tamagotchi-unity build:player
```

Set `AIRI_UNITY_STAGE_EXECUTABLE` to `Builds/Windows/airi-unity-stage.exe`, with its absolute path. Then start `pnpm dev:tamagotchi`, and select the Unity Stage button on the model page of Settings.

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
- `Assets/Airi/Stage/`: the connection, the VRM and MMD loaders, and the display output.
- `Assets/Airi/Editor/`: the project setup and the player build.
- `tools/run-unity.ps1`: runs Unity in batch mode, also with the Microsoft Store version of Unity Hub.
- `tests/stage-tamagotchi-unity.core/`: compiles `Core` with these limits, outside Unity.
- `tests/stage-tamagotchi-unity.tests/`: the verification host. It reads the fixtures of `stage-sidecar`.
- `Packages/com.yohawing.mmd-loader/`: a vendored package with patches. [`docs/vendor-patches.md`](docs/vendor-patches.md) lists them.

`apps/stage-tamagotchi/src/main/services/airi/unity-stage/player.integration.test.ts` tests a real player. It runs when `AIRI_UNITY_STAGE_PLAYER` names one. The test of a real MMD model also needs `AIRI_UNITY_STAGE_PMX_SAMPLE`, with the folder of an unpacked model. The repository has no MMD model, because MMD models have terms of their own.

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

`Core` uses Newtonsoft.Json. `dotnet` gets it from NuGet, and Unity gets it from the `com.unity.nuget.newtonsoft-json` package. `Stage` uses UniVRM v0.131.4 and URP, which `Packages/manifest.json` pins, and the vendored unity-mmd-loader v0.5.1.

MMD files use Shift_JIS, and a Mono player has no tables for it. So `StageBuild` copies `I18N.dll` and `I18N.CJK.dll` from the Editor to each player.

Sony does not give its plugin under the license of this repository, so `.gitignore` excludes `Assets/SRDisplayUnityPlugin/`. Model files also stay out of Git.
