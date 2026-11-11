import type { CharacterActivity, CharacterAttentionTarget, CharacterFrame } from '@proj-airi/stage-shared/stage-sidecar'

import type { ElectronStageSidecarStatus } from '.'

import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

/** A model file for the Unity stage. Electron main writes it to disk, and the sidecar reads it by path. */
export interface UnityStageSceneInput {
  modelId: string
  format: 'vrm'
  name: string
  fileName: string
  data: Uint8Array
}

/**
 * An MMD model for the Unity stage. The sidecar reads the textures by paths relative to the model, so Electron main
 * writes the whole package with its folders.
 */
export interface UnityStagePmxPackageInput {
  modelId: string
  name: string
  /** The path of the PMX file inside the package. */
  modelPath: string
  /** The paths come from a ZIP. Electron main refuses each path that can leave the folder of the model. */
  files: { path: string, data: Uint8Array }[]
}

/** A `.vrma` file for the Unity stage. Electron main writes it to disk, and the sidecar reads it by path. */
export interface UnityStageClipInput {
  id: string
  data: Uint8Array
}

/** A gesture in a `.vrma` file. A `full` clip replaces the whole idle while it plays. */
export interface UnityStageVrmaGestureInput extends UnityStageClipInput {
  part: 'upper' | 'full'
}

/**
 * A signal with no file, on its way to the sidecar. The renderer sends it and does not wait, because a frame comes 30
 * times each second and a late frame has no value.
 */
export type UnityStageSignal
  = | { type: 'host.character.expression', payload: { name: string, intensity: number, holdMs?: number } }
    | { type: 'host.character.gesture', payload: { kind: 'keys', id: string, part: 'upper', duration: number, tracks: { bone: string, times: number[], values: number[] }[] } }
    | { type: 'host.character.frame', payload: CharacterFrame }
    | { type: 'host.character.attention', payload: { target: CharacterAttentionTarget } }
    | { type: 'host.character.activity', payload: { activity: CharacterActivity } }
    | { type: 'host.room.screen', payload: { image: string } }

export const unityStageStart = defineInvokeEventa<ElectronStageSidecarStatus>('eventa:invoke:unity-stage:start')
export const unityStageStop = defineInvokeEventa<ElectronStageSidecarStatus>('eventa:invoke:unity-stage:stop')
export const unityStageGetStatus = defineInvokeEventa<ElectronStageSidecarStatus>('eventa:invoke:unity-stage:get-status')
export const unityStageApplySceneInput = defineInvokeEventa<void, UnityStageSceneInput>('eventa:invoke:unity-stage:apply-scene-input')
export const unityStageApplyPmxPackage = defineInvokeEventa<void, UnityStagePmxPackageInput>('eventa:invoke:unity-stage:apply-pmx-package')
export const unityStageApplyIdle = defineInvokeEventa<void, UnityStageClipInput>('eventa:invoke:unity-stage:apply-idle')
export const unityStagePlayVrmaGesture = defineInvokeEventa<void, UnityStageVrmaGestureInput>('eventa:invoke:unity-stage:play-vrma-gesture')
/** Records a failure that the renderer finds before the sidecar sees it, so Settings shows it. */
export const unityStageReportError = defineInvokeEventa<void, string>('eventa:invoke:unity-stage:report-error')
export const unityStageSignal = defineEventa<UnityStageSignal>('eventa:event:unity-stage:signal')
export const unityStageStatusChanged = defineEventa<ElectronStageSidecarStatus>('eventa:event:unity-stage:status-changed')
