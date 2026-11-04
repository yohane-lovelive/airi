# `@proj-airi/stage-shared`

Shared contracts and runtime-neutral helpers for AIRI stage applications and UI packages.

## Use this package

Use this package when a type or behavior must cross stage application boundaries without depending on Electron, browser-only code, or a feature UI package.

The `plugin-host` entrypoint owns the serializable Plugin Host snapshots exchanged between the Electron main process and shared renderer code:

```ts
import type { PluginHostDebugSnapshot } from '@proj-airi/stage-shared/plugin-host'
```

The `model-assets` entrypoint owns model file manifests, download status, and
the storage adapter contract. Use a platform adapter to store and open files.
It does not own a recognizer or Worker.

The `speaker-model` entrypoint pins the CAM++ speaker embedding pack. The renderer and the Electron main process both read it:

```ts
import { speakerModel } from '@proj-airi/stage-shared/speaker-model'
```

The `perception` entrypoint owns the screen detectors of autonomous speech. `ScreenDetector` reads grayscale thumbnails and gives screen events and an activity level, with no model call:

```ts
import { ScreenDetector } from '@proj-airi/stage-shared/perception'

const detector = new ScreenDetector({ width: 64, height: 36 })
const events = detector.observe({ at: Date.now(), thumbnail, app: 'Code' })
```

`regionDiff` measures the change inside one part of two thumbnails, for example for a watch. `ScreenDetector` settles before it compares, it knows familiar screens and the usual change of each app, and it counts an app switch after a dwell time. `DETECTOR_LIMITS` holds the thresholds.

The frame policies pick the frames of one decision turn. `FRAME_POLICY_NAMES` lists them. `pickFreshKeyframes` picks the newest frame and key frames, `pickContactSheet` picks up to six tiles, `contactSheetLayout` places them, and `sceneAnchorAt` finds the anchor frame of the current scene. The app and `evals/autonomy-replay` use the same functions, so a replay picks the frames that the app picks.

The `body-motion` entrypoint owns the procedural layer of 3D models. `ProceduralBodyMotion` gives breath, a small sway, a neck and a head that follow the gaze late, a gaze that moves away while the model thinks, and nods on speech peaks. `BodyPoseApplier` adds its offsets to the bones of a model, and `SpeechLevelMeter` measures the speech loudness. The VRM and MMD renderers share them:

```ts
import { BodyPoseApplier, ProceduralBodyMotion } from '@proj-airi/stage-shared/body-motion'

const motion = new ProceduralBodyMotion()
const pose = new BodyPoseApplier({ spine, chest, neck, head })
// Each frame: pose.undo() before the clip runs, then pose.apply(motion.update(delta, input).bones) after it.
```

The same entrypoint owns the gestures. `BUILT_IN_GESTURES` holds eight gestures as data, `matchGesture` chooses one for the free-text `motion` of an `ACT` marker, and `GestureLayer` plays a gesture over the parts of the idle that it moves. The layer takes an adapter for the mixer of a renderer, so it needs no three.js dependency. `gestureFromGeneratedTracks` turns the rotation tracks of a generated clip into a gesture of the upper body: the hips and the legs lose their tracks, the keys are smoothed, and the hands get relaxed fingers.

## Do not use this package

Keep Electron IPC definitions in the Electron application. Keep UI state and actions in `@proj-airi/stage-ui`. Keep Extension runtime and manifest behavior in `@proj-airi/plugin-sdk`.

Do not add application startup, persistence, or platform-specific side effects here.
