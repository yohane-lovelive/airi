# `@proj-airi/stage-tamagotchi-unity`

Unity display sidecar for `stage-tamagotchi`. The target is the Sony ELF-MN1 spatial reality display. [The ADR](../../docs/ai/adr/2026-11-06-unity-stage-sidecar.md) has the design and the steps.

## What It Does

- Holds the Unity side of the display sidecar. Electron stays the brain, and Unity only draws.
- Holds `Assets/Airi/Core`, the part with no Unity reference: the protocol, the WebSocket client, and the frame conversion.
- Tests `Core` through `dotnet`. The tests need no Unity install and no Unity license.

## Current State

Only step U0 is done, so this folder is not a Unity project yet. Step U2 adds `Packages/`, `ProjectSettings/`, the `.meta` files, and the scenes. Nothing starts this sidecar yet.

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
