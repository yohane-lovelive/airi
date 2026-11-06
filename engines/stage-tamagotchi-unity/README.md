# `@proj-airi/stage-tamagotchi-unity`

Unity display sidecar for `stage-tamagotchi`. The target is the Sony ELF-MN1 spatial reality display. [The ADR](../../docs/ai/adr/2026-11-06-unity-stage-sidecar.md) has the design and the steps.

## What It Does

- Holds the Unity side of the display sidecar. Electron stays the brain, and Unity only draws.
- Holds `Assets/Airi/Core`, the part with no Unity reference: the protocol, the WebSocket client, and the frame conversion.
- Tests `Core` through `dotnet`. The tests need no Unity install and no Unity license.

## Current State

Steps U0 and U1 are done. The Electron side can start a sidecar and send it the model and the signals. This folder is not a Unity project yet. Step U2 adds `Packages/`, `ProjectSettings/`, the `.meta` files, and the scenes.

## Check the Electron Side Without Unity

The script `apps/stage-tamagotchi/scripts/fake-stage-sidecar.mjs` obeys the protocol and prints each message.

1. Set the variable `AIRI_UNITY_STAGE_ATTACH` to `1`, and start `pnpm dev:tamagotchi`.
2. Select the Unity Stage button on the model page of Settings.
3. In `apps/stage-tamagotchi`, run the script with the path of the attach file:

```bash
node scripts/fake-stage-sidecar.mjs --attach=<userData>/unity-stage/attach.json
```

After step U2, set `AIRI_UNITY_STAGE_EXECUTABLE` to a built player, or start Play mode in place of the script.

## When To Use It

- Use it for the Unity scene, the VRM loading, and the display output.
- Use it when the character must show on a spatial reality display.

## When Not To Use It

- Do not put chat, speech, memory, or settings logic here. These stay in Electron.
- Do not define the protocol here. `packages/stage-shared/src/stage-sidecar` owns it, and `Core` obeys it.
- Do not use it for a transparent desktop mascot. The three.js stage serves the desktop.

## Directory Layout

- `Assets/Airi/Core/`: code with no `UnityEngine` reference. It must compile with C# 9 on .NET Standard 2.1, as in Unity.
- `tests/stage-tamagotchi-unity.core/`: compiles `Core` with these limits, outside Unity.
- `tests/stage-tamagotchi-unity.tests/`: the verification host. It reads the fixtures of `stage-sidecar`.

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

`Core` uses Newtonsoft.Json. `dotnet` gets it from NuGet, and Unity gets it from the `com.unity.nuget.newtonsoft-json` package.

Sony does not give its plugin under the license of this repository, so `.gitignore` excludes `Assets/SRDisplayUnityPlugin/`. Model files also stay out of Git.
