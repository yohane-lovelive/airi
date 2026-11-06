# Unity stage sidecar

Status: accepted

Japanese version: [2026-11-06-unity-stage-sidecar.ja-JP.md](2026-11-06-unity-stage-sidecar.ja-JP.md)

## Context

The owner wants to show the AIRI character in 3D on the Sony ELF-MN1 spatial reality display. Sony gives a Unity plugin for this display. The agent, speech, and memory code stays in the Electron app. A move of the whole app to Unity discards this code.

### The precedent

`engines/stage-tamagotchi-godot` is a display sidecar. `apps/stage-tamagotchi/src/main/services/airi/godot-stage/index.ts` starts the process and opens a local WebSocket. The sidecar connects back with a token.

The Godot path carries only the model and the camera. `Stage.vue` shows a text panel for the `godot` renderer, and every signal of the character stops there:

- The emotion queue has no `godot` branch.
- The `ACT` marker plays gestures only for `vrm` and `mmd`.
- The mouth, the speech level, and the procedural layer are in the three.js and MMD components.

So this ADR must define a new path for these signals. It cannot copy this part from Godot.

### What Sony states

These facts come from the Sony developer pages, read on 2026-11-06.

| Item | ELF-MN1 | ELF-SR1 and ELF-SR2 |
| --- | --- | --- |
| Plugin | "Coming soon". The display goes on sale on 2026-12-11. | v2.6.0 |
| Unity version | Not stated | 2022.3, Unity 6, Unity 6.3 |
| Render pipeline | URP recommended | BRP, URP, HDRP |
| Windows build | Intel 64-bit. A built `.exe` shows content on the display. | Intel 64-bit, Mono only |
| Android build | ARM64, IL2CPP | Not available |
| Main prefab | `PortraitSRDisplayManager` | `SRDisplayManager` |

These facts about the prefab change the design:

- The prefab holds `LeftEyeCamera` and `RightEyeCamera`. It has no `MainCamera`. So the scene cannot assume one camera, and camera settings do not apply to this display.
- Only one manager can be in a scene.
- `SRD View Space Scale` sets the scale. The manager overrides the scale of its own GameObject.
- The real view space is "0.4x0.2x0.2m at most". The pages do not state which axis is vertical on the portrait display.
- Sony tells developers to keep objects in the view space. Spatial Clipping handles objects that extend out of it.
- The pages do not state whether the app can run without focus or must be fullscreen.

### This PC

Neither Unity Hub nor a Unity Editor is installed. The .NET SDK 10.0.401 is installed. No ELF-MN1 is available until the sale date.

## Decision

### Electron stays the brain, and Unity only draws

Unity gets no chat, speech, memory, or settings logic. Electron plays the audio, so Unity does not touch audio.

The scope is `apps/stage-tamagotchi` on Windows. The smartphone path of the ELF-MN1 is out of scope, because the brain runs on the PC.

The feature stays off by default and is experimental, like Godot Stage.

### Engine and project settings

- The project is at `engines/stage-tamagotchi-unity`, next to the Godot engine.
- The Editor version is Unity 6.3 LTS. This is the newest version that Sony lists. `unity-mmd-loader` needs 6000.0 or later, and UniVRM needs 2022.3 or later.
- The render pipeline is URP, the backend is Mono, and the architecture is Intel 64-bit.
- Active Input Handling stays on the old Input Manager, the default of the project. Sony requires the old Input Manager or `Both` for ELF-SR1 and ELF-SR2, and `Both` needs one more package that the stage does not use.
- `Application.runInBackground` is `true`. The owner uses the Electron window while the character moves.
- `StageProjectSetup.Apply` writes these settings through the Unity API, so a review can read each choice in one file.

`tools/run-unity.ps1` runs Unity in batch mode. The Microsoft Store version of Unity Hub keeps its license in a virtualized folder of its package, so a plain `Unity.exe` run fails with "No valid Unity Editor license found". The script starts Unity inside the package of the Hub, and the license files stay as they are. A start inside a package gives no exit code, so the script reads the result from the log.

Unity keeps packages with a `package.json` in `Library/`, and the workspace glob `engines/**` of pnpm reads them. So `pnpm-workspace.yaml` excludes `Library/` and `Temp/`.

If the ELF-MN1 plugin needs another Unity version, the project changes to that version. This is a settings change, and the design stays the same.

### Project layout

```text
engines/stage-tamagotchi-unity/
  package.json                 # scripts: typecheck, test
  README.md
  Assets/Airi/Core/            # No UnityEngine reference (noEngineReferences)
  Assets/Airi/Stage/           # MonoBehaviours, UniVRM use
  Assets/Airi/SrDisplay/       # Compiled only when the Sony plugin is present
  Packages/manifest.json
  ProjectSettings/
  tests/                       # dotnet test host that compiles Assets/Airi/Core
```

`Core` has the protocol parser, the WebSocket client loop, and the frame conversion. Step U3 adds the rules for holds and fades. `Core` has no Unity reference, so `dotnet` can test it on any PC and in CI, without a Unity license. The Godot engine uses the same approach with its verification host.

`Core` uses Newtonsoft.Json, the choice of the owner. Unity has an official package for it, and `dotnet` gets the same library from NuGet. A separate project compiles `Core` with C# 9 on .NET Standard 2.1, so a build outside Unity fails on the same language limits.

These files stay out of Git: the Sony plugin package, model files, and Unity build output.

### Process start

| Mode | Use | How it starts |
| --- | --- | --- |
| Player | Normal use | Electron main starts the built `.exe` with `--airi-ws-url=<url>`. The path comes from `AIRI_UNITY_STAGE_EXECUTABLE` in development. |
| Attach | Work in the Editor | Electron main does not start a process. It writes the URL and token to `<userData>/unity-stage/attach.json`. Play mode in the Editor reads this file and connects. |

Godot can start its Editor with a project path, but a Unity Editor start takes too long for this use. Sony also requires the Settings app for Play mode on the display, so the attach mode is the normal development path.

`AIRI_UNITY_STAGE_ATTACH=1` selects the attach mode, and it has priority over the executable. In this mode, `start` returns at once with the status `starting`. The status changes to `running` when the sidecar sends `stage.ready`. When the sidecar disconnects, the status returns to `starting`, and the URL stays valid. So Play mode can stop and start again. A stop deletes `attach.json`, because its socket no longer exists.

Release packaging is out of scope until step U5. A Unity build needs a license, so CI cannot produce it without extra work.

### Protocol

The envelope is the same as the Godot envelope: `{ type, payload }` as JSON text. The connection stays on `127.0.0.1` with a random token.

Host to sidecar:

| Type | Payload | Rate |
| --- | --- | --- |
| `host.scene.apply` | `format`, `modelId`, `name`, `path` | On a model change |
| `host.character.idle` | `path` of a `.vrma` file | On a model change |
| `host.character.expression` | `name`, `intensity`, `holdMs` | On an `ACT` marker |
| `host.character.gesture` | `kind`, `id`, `part`, and `tracks` with `duration` (`keys`), or `path` of a `.vrma` file (`vrma`) | On an `ACT` marker |
| `host.character.frame` | `mouth` (A, E, I, O, U), `bones` (spine, chest, neck, head), `eyes` | 30 each second |
| `host.shutdown` | None | On a stop |

Sidecar to host:

| Type | Payload |
| --- | --- |
| `stage.ready` | None |
| `stage.fatal` | `message` |
| `scene.applied` | `modelId`, `avatarBounds` |
| `scene.error` | `message` |
| `character.error` | `message`, `type` of the message that failed |

The Valibot schemas go to `packages/stage-shared/src/stage-sidecar/`. The names have no engine in them, so Godot can use the same messages later. A JSON fixture file in that folder holds one valid example of each message. The TypeScript tests and the C# tests both read this file, so the two sides cannot drift.

Files stay on disk, as in the Godot path. Electron main writes model bytes and `.vrma` bytes to `<userData>/unity-stage/`, and it sends the path.

### Who computes what

| Signal | Computed in | Applied in |
| --- | --- | --- |
| Which emotion and gesture, and the gesture match | Renderer (`Stage.vue`, `useMotionLibraryStore`) | Unity |
| Expression hold and fade | Unity | Unity |
| Gesture clip playback and the mix with the idle | Unity (like `GestureLayer`) | Unity |
| Mouth vowels | Renderer (`createWLipSyncVowelDriver`) | Unity |
| Breath, sway, nods, thinking look-away | Renderer (`ProceduralBodyMotion`) | Unity |
| Spring bones and blink | Unity (UniVRM) | Unity |

The procedural layer stays in TypeScript and streams its offsets. A C# copy gives two sets of tuning values and two sets of tests. The offsets are small and slow, so 30 frames each second with smoothing in Unity is sufficient.

Clips play in Unity, because a stream of a full body pose has visible jitter and clip data is already in a file or a short list of keys.

The mouth follows the lip sync node only while the character speaks. The node keeps its last values when its input has no audio, and the frames continue. So without this rule, the mouth stays open after the speech ends. The live check of step U1 found this fault, and the Live2D path has the same rule.

The stream has a deadline. If no frame arrives for 500 ms, Unity fades the mouth and the offsets to zero. So a throttled renderer or a stopped app does not freeze the character with an open mouth. The renderer sends frames from a worker timer, not from `requestAnimationFrame`, because a hidden window stops `requestAnimationFrame`.

### `Stage.vue` and the new renderer

`StageModelRenderer` gets the value `unity`. `Stage.vue` stays mounted without a canvas, because it owns the voice output. The branches for `vrm` get a matching branch for `unity`.

`stage-ui` cannot import the Eventa contracts of `stage-tamagotchi`. So `stage-ui` gets a small store with a `StageSidecarOutput` interface. The desktop app registers an implementation that invokes Eventa, and the store has no implementation on the web app.

The stage page sends the model, through `useUnityStageBridge`. This differs from Godot, where the Settings page sends the model. With Godot, a change of the character while Settings is closed does not reach the sidecar. The Unity path must not have this limit, because the agent can change the character at any time.

### Sidecar host in Electron main

`godot-stage/index.ts` has 972 lines, and most of them do not depend on Godot: the process lifecycle, the socket, the ready wait, and the status channel. This ADR moves them to `services/airi/stage-sidecar/`. Godot and Unity each keep a thin file with the executable path, the arguments, and their own messages.

This change touches upstream code, so a rebase can have conflicts in this file. The other choice is a 972-line copy, and the repository rules reject one-off copies. The Godot behavior must not change.

The Godot manager had no tests before this change. So `godot-stage/index.test.ts` passed on the old code first, and it passes on the new code without a change. These tests use a real child process and a real socket, with `apps/stage-tamagotchi/scripts/fake-stage-sidecar.mjs` in place of the engine.

### Coordinate frame

Gesture keys rotate the normalized bones of a VRM humanoid. The frame is right-handed, faces +Z, and has +Y up. UniVRM keeps the model facing +Z in the left-handed Unity frame, which mirrors the X axis. So the conversion is `(x, y, z, w)` to `(x, -y, -z, w)`.

This is one pure function in `Core`, with tests. Step U3 checks the result against the three.js renderer with the 8 built-in gestures.

### Models

**VRM** uses UniVRM v0.131.4 (MIT). I read these names in its source:

- `Vrm10.LoadPathAsync` with `canLoadVrm0X: true` loads VRM 1.0 files and VRM 0.x files. The Godot path has no VRM 1.0 support at this time.
- `UrpVrm10MaterialDescriptorGenerator` gives the URP materials through the `materialGenerator` parameter.
- `Vrm10RuntimeExpression.SetWeight` sets expressions.
- `VrmAnimationImporter` and `Vrm10AnimationInstance` load and play `.vrma` files.

The README of UniVRM names the backends `.NET` and IL2CPP, and does not name Mono. Step U2 tested a Mono player: it loads and shows VRM 0.x models. No VRM 1.0 file was available for this test.

`Shader.Find` finds the MToon shader at runtime, and no asset of the project uses it. So the project includes the shader through the always-included list of the graphics settings. If a build does not have it, the sidecar reports `stage.fatal` at its start, and each model does not fail one at a time.

A new model replaces the old model only after it loads. So a broken file keeps the old model on the stage. Memory does not grow with each replacement: a measured run gave 614, 700, 703, 707, and 706 MB for each 20 loads. `player.integration.test.ts` runs these cases against a real player, when `AIRI_UNITY_STAGE_PLAYER` names one.

**MMD** has no clear choice, so it is a separate step with a prototype. The owner picks a model in the app, so a loader must read a PMX file at runtime. A Unity Editor import does not work in a built player.

| Library | License | Updated | Unity 6 and URP | Runtime PMX load |
| --- | --- | --- | --- | --- |
| [unity-mmd-loader](https://github.com/yohawing/unity-mmd-loader) v0.5.1 | MIT | 2026-10 | Yes | Not confirmed. The README describes import in the Editor. |
| [mmd-anim](https://github.com/yohawing/mmd-anim) v0.5.4 | MIT | 2026-11 | Host-defined | Yes, from bytes. AIRI must build meshes and materials. The README says "still in an evaluation stage". |
| [UnityPMXRuntimeLoader](https://github.com/hobosore/UnityPMXRuntimeLoader) | MIT | 2020-02 | Not stated | Yes, `PMXModelLoader.LoadPMXModel(path)`. |
| [libmmd-for-unity](https://github.com/OneYoungMean/libmmd-for-unity) | BSD-3-Clause | 2019-08 | Not stated | Yes. Includes PMD and Bullet physics. |

The MMD look of AIRI (the PBR modes, the bloom, and the depth of field) stays in three.js. Step U4 does not port it.

### Display output

A small interface, `IStageOutput`, has two implementations:

- `WindowOutput`: one normal camera in a normal window. This is the output for steps U2 to U4. The camera frames the avatar from its bounds.
- `SrDisplayOutput`: places `PortraitSRDisplayManager` in the scene and removes the normal camera.

`Assets/Airi/SrDisplay/` has its own assembly definition and a define constraint, so the project compiles without the Sony plugin.

The scale comes from the avatar bounds, not from a fixed number. Step U5 sets `SRD View Space Scale` so that the full character, with a margin for arms and hair, stays in the view space. Spatial Clipping stays on. The earlier note of "a desk corner of 2 m at 1/10 scale" is only a calculation, and the vertical axis of the view space is unknown.

### Room state

No room or seat state exists in the repository at this time. This ADR does not add one. When a room arrives, its state must be independent of the renderer, so that three.js and Unity can share it.

## Steps

| Step | Content | Needs Unity | Done when |
| --- | --- | --- | --- |
| U0 | Engine folder, `Core` with tests through `dotnet`, `stage-sidecar` schemas, shared fixture | No | TypeScript and C# tests pass on the same fixture. |
| U1 | `stage-sidecar` host, Godot on the new host, Unity service, Eventa contracts, `unity` renderer, settings switch | No | A fake sidecar script receives the model path and the signals. Godot tests still pass. |
| U2 | Unity project, VRM load, window output, attach and player modes | Yes | A VRM model selected in AIRI shows in a Unity window. |
| U3 | Expressions, idle, gestures, mouth, procedural offsets | Yes | A chat reply with TTS moves the character. The 8 gestures match three.js. |
| U4 | MMD prototype, then the choice of a library | Yes | An owner PMX model shows and speaks, or this ADR records why not. |
| U5 | `SrDisplayOutput`, scale from bounds, gaze at the viewer, packaging | Yes, plus the plugin and the display | The character shows on a real ELF-MN1 in the view space. |

Step U5 cannot start before 2026-12-11. Its message for the viewer position is not in this ADR, because the plugin is not available to read.

## What this design does not do

These are differences from the three.js stage. Each one is a choice, not a defect to hide:

- No transparent desktop mascot window. The Unity window is opaque. The target is the ELF-MN1, and the three.js stage still serves the desktop.
- No camera sliders in Settings for Unity at the first steps. `SrDisplayOutput` has no camera to control. `WindowOutput` frames the avatar by itself.
- No pointer interaction with the Unity character.
- No Live2D, Spine, or tachie in Unity.

## Risks

| Risk | Result | Action |
| --- | --- | --- |
| The ELF-MN1 plugin has requirements that are not public yet. | Project settings change. | Read the plugin notes on release. All Sony use is in `SrDisplay/`. |
| The plugin needs window focus or fullscreen. | The owner cannot use the chat window at the same time. | Test on the real display in step U5. Sony does not state this. |
| UniVRM does not work on Mono. | Step U2 stops. | Test it first in step U2. If it fails, check the IL2CPP support of the Windows plugin. |
| No runtime PMX loader is good enough. | MMD models do not show in Unity. | Step U4 is a prototype, and the owner decides with its result. |
| The 30 Hz JSON stream causes garbage collection pauses in Unity. | Small stutters. | Measure in step U3. If the pauses are visible, change this message to a binary frame. |
| Sony warns that content outside the view space can harm comfort. | The owner can feel discomfort. | Scale from bounds, keep Spatial Clipping on, and check on the real display. |

## Sources

- [ELF-MN1 download (smartphone)](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/download-info) and [ELF-MN1 download (Windows)](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/download-info2)
- [ELF-MN1 prefab](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/unity/srdmanagerprefab), [World Scaling](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/unity/worldscaling), [Spatial Clipping](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/unity/spatialclipping), [Android builds](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/unity/builds-for-android)
- [ELF-SR Unity quickstart](https://xyn.sony.net/en/developer/setup/spatial-reality-display/unity/quickstart)
- [UniVRM](https://github.com/vrm-c/UniVRM)
