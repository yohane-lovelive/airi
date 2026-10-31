# @proj-airi/stage-ui-mmd

MMD (MikuMikuDance) scene components, composables, and stores for Project AIRI.

## What it does

Renders PMX/PMD models with VMD/VPD motion support inside AIRI's stage,
reaching feature parity with the Live2D and VRM renderers:

- **Model loading** for `.pmx`/`.pmd`, from a packaged ZIP (model + textures)
  or a bare model URL. ZIP names without the UTF-8 flag are read as Shift_JIS
  when they are not valid UTF-8, as older Windows and Japanese tools write them.
- **Graphics** (`utils/mmd-graphics`, `composables/mmd/post-processing`):
  optional post-processing with bloom, tone mapping (Neutral, AgX, or ACES),
  color grading, the vignette, and SMAA or multisampling. The quality preset
  is `off` by default, which renders as before. Each device keeps its own
  preset, because GPUs differ. The alpha channel survives, so a transparent
  window still shows the desktop behind the model.
- **Shading** (`utils/mmd-pbr`, `utils/mmd-materials`,
  `composables/mmd/physical-lighting`): `toon` (the default) keeps the loaded
  toon materials. `hybrid` swaps each material for a physically based twin,
  but faces and eyes stay toon. `pbr` swaps every material. The twin takes
  the slot of the toon material, so three-mmd's SDEF shadow pass still finds
  it. A mode change needs no reload. Hybrid and PBR add a studio environment
  light, soft self-shadows, a rim light, and, on the high preset, ambient
  occlusion.
  - The kind of each material (face, eyes, skin, hair, cloth, fur, leather,
    metal, other) sets its roughness, metalness, sheen, and gloss coat. AIRI
    guesses it from the material name, then the texture file name, in
    Japanese, English, or romaji (`kami.bmp` is hair).
  - A material whose vertices mostly follow the head bone `頭` is the face,
    unless its name says hair or eyes. PMD face skin often has no name, or the
    name of a shared texture.
  - The owner can change the kind and the values of each material. The
    device keeps the changes for each model, by material index. Names do not
    work as keys, because one name can cover the face skin and the clothes.
- **VRM motions** (`utils/vrma-retarget`, `utils/vrma-loader`): retargets a
  `.vrma` clip to the standard MMD bones, with a rest pose correction for the
  A-pose and positions for the leg IK bones, so IK stays on. The scene plays
  the VRM idle loop through it until the owner chooses a VMD idle. Pass the
  loop as `defaultIdleAnimationUrl`.
- **Model packages** (`utils/mmd-package`): reads a picked folder or a ZIP,
  lists its models, and packs one model with its textures into a ZIP for the
  loader. The model selector uses it for folder import and for folders that
  hold several models, for example the outfits of one character.
- **Physics** for hair, skirts, and custom rigs via Bullet (Ammo.js) — rigid
  bodies and 6-DOF spring joints, toggleable at runtime.
- **IK** (CCD solver) and **append-bone ("grant")** propagation for standard
  and custom rigs.
- **Importable, mappable motions**: import VMD clips (persisted to IndexedDB,
  synced across windows), set one as the looping idle, preview any as a
  one-shot, remove them, and map AIRI emotions to gesture motions.
- **Morph-based lip-sync** driven by the shared wLipSync profile, mapping
  phonemes to the canonical あいうえお mouth morphs, with per-slot morph
  remapping for non-standard models.
- **Emotion expressions** via morph cross-fades.
- **Looking-at modes** (camera / cursor / disabled) with idle saccades, plus
  procedural blink.
- **Scene settings**: model transform, camera FOV, ambient + directional
  lights, albedo glow, render scale, physics gravity, and per-material opacity
  — all live, persisted, and synced across windows.

It builds on [`@moeru/three-mmd`](https://github.com/moeru-ai/three-mmd) for
PMX/PMD loading, VMD animation building, IK, append-bone propagation, toon
materials, outlines, and the shared runtime update order. Physics comes from
`@moeru/three-mmd-physics-ammo` and is loaded lazily, so the Ammo WASM runtime
is initialized only after a live MMD model is mounted.

## How to use

The package exposes the same scene contract as the other renderers, so it is
wired through `@proj-airi/stage-ui`'s `Stage.vue` automatically when the
selected model resolves to the `mmd` renderer:

```ts
import { MMDScene, useMMD } from '@proj-airi/stage-ui-mmd'
```

```vue
<MMDScene
  v-model:state="state"
  :audio-context="audioContext"
  :model-src="modelUrl"
  :cursor-position="cursorPosition"
  :current-audio-source="audioSource"
  :enable-orbit-controls="true"
  @error="onError"
/>
```

The component exposes `canvasElement()`, `captureFrame()`,
`setEmotion(name, intensity)`, `listMorphs()`, and `listMotions()`.

Runtime configuration (physics/IK/grant toggles, gaze tracking, scale,
morph overrides, emotion→motion mapping) lives in the `useMMD` Pinia store and
is edited through the model settings panel.

## When to use it

- Displaying MMD/MikuMikuDance characters (`.pmx`/`.pmd`) on the AIRI stage.
- When you need physics-driven secondary motion, IK, and VMD playback.

## When not to use it

- For VRM avatars use `@proj-airi/stage-ui-three`; for Live2D use
  `@proj-airi/stage-ui-live2d`; for Spine use `@proj-airi/stage-ui-spine`.
- In environments without WebGL/WASM support (MMD physics requires Ammo WASM).
