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

It settles before it compares, it knows familiar screens and the usual change of each app, and it counts an app switch after a dwell time. `DETECTOR_LIMITS` holds the thresholds.

## Do not use this package

Keep Electron IPC definitions in the Electron application. Keep UI state and actions in `@proj-airi/stage-ui`. Keep Extension runtime and manifest behavior in `@proj-airi/plugin-sdk`.

Do not add application startup, persistence, or platform-specific side effects here.
