import type { GestureClipSource } from '@proj-airi/stage-shared/body-motion'
import type { CharacterAttentionTarget } from '@proj-airi/stage-shared/stage-sidecar'
import type { DisplayModel } from '@proj-airi/stage-ui/stores/display-models'

import type { ElectronStageSidecarStatus } from '../../shared/eventa'

import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaContext, useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { gestureRotationTracks } from '@proj-airi/stage-shared/body-motion'
import { animations } from '@proj-airi/stage-ui-three/assets/vrm'
import { DisplayModelFormat } from '@proj-airi/stage-ui/stores/display-models'
import { useSettings } from '@proj-airi/stage-ui/stores/settings'
import { useStageSidecarStore } from '@proj-airi/stage-ui/stores/stage-sidecar'
import { storeToRefs } from 'pinia'
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  unityStageApplyIdle,
  unityStageApplyPmxPackage,
  unityStageApplySceneInput,
  unityStageGetStatus,
  unityStagePlayVrmaGesture,
  unityStageReportError,
  unityStageSignal,
  unityStageStart,
  unityStageStatusChanged,
  unityStageStop,
} from '../../shared/eventa/unity-stage'
import { readDisplayModelFile, readPmxPackage } from './display-model-file'

/**
 * Makes the renderer of this window follow the sidecar.
 *
 * The sidecar lifecycle owns this choice, so a window that opens later learns it from the status. While an attached
 * Editor stops and comes back, the status is `starting`, and the choice stays. So the character does not jump to the
 * built-in stage between two runs of Play mode.
 */
export function syncUnityStageRenderer(
  settingsStore: ReturnType<typeof useSettings>,
  status: Pick<ElectronStageSidecarStatus, 'state'>,
) {
  if (status.state === 'running') {
    settingsStore.setStageModelRenderer('unity')
    return
  }

  if ((status.state === 'stopped' || status.state === 'error') && settingsStore.stageModelRenderer === 'unity')
    settingsStore.restoreBuiltInStageModelRenderer()
}

/**
 * Connects the stage of the main page to the Unity sidecar.
 *
 * It lives on the page that owns the stage, not in Settings. So a change of the character reaches the sidecar while
 * Settings is closed.
 *
 * Owned state: the output of `useStageSidecarStore`, the last known status of the sidecar, and the last attention target.
 * All end with the scope of the page. A new `running` status sends the idle, the model, and a `viewer` attention again,
 * because a new sidecar has none of them.
 */
export function useUnityStageBridge() {
  const { t } = useI18n()
  const settingsStore = useSettings()
  const { stageModelRenderer, stageModelSelectedDisplayModel } = storeToRefs(settingsStore)
  const context = useElectronEventaContext()
  const stageSidecar = useStageSidecarStore()
  const getStatus = useElectronEventaInvoke(unityStageGetStatus)
  const applyIdle = useElectronEventaInvoke(unityStageApplyIdle)
  const applySceneInput = useElectronEventaInvoke(unityStageApplySceneInput)
  const applyPmxPackage = useElectronEventaInvoke(unityStageApplyPmxPackage)
  const playVrmaGesture = useElectronEventaInvoke(unityStagePlayVrmaGesture)
  const reportError = useElectronEventaInvoke(unityStageReportError)
  const sidecarState = shallowRef<ElectronStageSidecarStatus['state']>('stopped')

  /** A newer model or session replaces the sync in progress, so an old model cannot arrive last. */
  let sceneGeneration = 0

  /** The renderer sends only changes, so this copy lets a new sidecar learn the current target. */
  let attention: CharacterAttentionTarget = 'none'

  function sendAttention() {
    context.value.emit(unityStageSignal, { type: 'host.character.attention', payload: { target: attention } })
  }

  async function playGesture(source: GestureClipSource) {
    try {
      if (source.kind === 'keys') {
        context.value.emit(unityStageSignal, {
          type: 'host.character.gesture',
          payload: {
            kind: 'keys',
            id: source.id,
            part: source.part,
            duration: source.gesture.duration,
            tracks: gestureRotationTracks(source.gesture),
          },
        })
        return true
      }

      await playVrmaGesture({ id: source.id, part: source.part, data: new Uint8Array(source.vrma) })
      return true
    }
    catch (error) {
      console.error('[Unity Stage] Failed to play a gesture.', error)
      return false
    }
  }

  stageSidecar.setOutput({
    setExpression(name, intensity, holdMs) {
      context.value.emit(unityStageSignal, {
        type: 'host.character.expression',
        payload: holdMs ? { name, intensity, holdMs } : { name, intensity },
      })
    },
    playGesture,
    sendFrame(frame) {
      context.value.emit(unityStageSignal, { type: 'host.character.frame', payload: frame })
    },
    setAttention(target) {
      attention = target
      sendAttention()
    },
  })

  async function sendIdle() {
    const response = await fetch(animations.idleLoop.toString())
    if (!response.ok)
      throw new Error(`Failed to fetch the idle clip (${response.status} ${response.statusText})`)

    await applyIdle({ id: 'idle-loop', data: new Uint8Array(await response.arrayBuffer()) })
  }

  async function sendVrmModel(model: DisplayModel, generation: number) {
    const file = await readDisplayModelFile(model)
    if (generation !== sceneGeneration)
      return

    await applySceneInput({
      modelId: model.id,
      format: 'vrm',
      name: model.name,
      fileName: file.fileName,
      data: file.data,
    })
  }

  async function sendPmxModel(model: DisplayModel, generation: number) {
    const modelPackage = await readPmxPackage(model)
    if (generation !== sceneGeneration)
      return

    if (!modelPackage) {
      await reportError(t('tamagotchi.settings.pages.models.unity-stage.unsupported-model'))
      return
    }

    await applyPmxPackage({
      modelId: model.id,
      name: model.name,
      modelPath: modelPackage.modelPath,
      files: modelPackage.files,
    })
  }

  async function syncScene(model: DisplayModel) {
    sceneGeneration += 1
    const generation = sceneGeneration

    // The sidecar reads VRM and PMX files. A stored MMD model is a ZIP that can hold a PMD file, so the PMD check of
    // that format comes after the unpack.
    if (model.format !== DisplayModelFormat.VRM && model.format !== DisplayModelFormat.PMXZip) {
      await reportError(t('tamagotchi.settings.pages.models.unity-stage.unsupported-model'))
      return
    }

    try {
      await sendIdle()

      if (model.format === DisplayModelFormat.VRM)
        await sendVrmModel(model, generation)
      else
        await sendPmxModel(model, generation)
    }
    catch (error) {
      if (generation === sceneGeneration)
        await reportError(errorMessageFrom(error) ?? 'Failed to send the model to the Unity stage.')
    }
  }

  /**
   * The ID of the model that the sidecar must show, or undefined while it cannot receive one. Each new value makes the
   * sidecar load a model, so a same-value update must not start a sync.
   *
   * This is one scalar on purpose. With an array of sources, one shallow source makes `watch` call back on each trigger,
   * also when no value changed. The live check of step U1 saw this: one model change sent the model two times.
   */
  const sceneModelId = computed(() => stageModelRenderer.value === 'unity' && sidecarState.value === 'running'
    ? stageModelSelectedDisplayModel.value?.id
    : undefined)

  watch(sceneModelId, (modelId) => {
    const model = stageModelSelectedDisplayModel.value
    if (modelId && model)
      void syncScene(model)
  })

  function applyStatus(status: ElectronStageSidecarStatus) {
    const started = status.state === 'running' && sidecarState.value !== 'running'
    sidecarState.value = status.state
    syncUnityStageRenderer(settingsStore, status)

    // A new sidecar starts with `none`, so only `viewer` needs to go again.
    if (started && attention === 'viewer')
      sendAttention()
  }

  const disposeStatusListener = context.value.on(unityStageStatusChanged, (event) => {
    if (event.body)
      applyStatus(event.body)
  })

  // The main process keeps running through a reload of this page, so the sidecar can already run.
  void getStatus()
    .then(applyStatus)
    .catch(error => console.warn('[Unity Stage] Failed to read the status.', error))

  onScopeDispose(() => {
    sceneGeneration += 1
    disposeStatusListener?.()
    stageSidecar.setOutput(undefined)
  })
}

/**
 * The switch of the Unity stage, for Settings.
 *
 * @param stopOtherStage Runs before a start, because one sidecar draws at a time.
 */
export function useUnityStageSwitch(stopOtherStage: () => Promise<unknown>) {
  const settingsStore = useSettings()
  const context = useElectronEventaContext()
  const getStatus = useElectronEventaInvoke(unityStageGetStatus)
  const start = useElectronEventaInvoke(unityStageStart)
  const stop = useElectronEventaInvoke(unityStageStop)
  const status = ref<ElectronStageSidecarStatus>({ state: 'stopped', pid: null, updatedAt: 0 })
  const switching = ref(false)
  const switchError = ref<string>()

  /** True also while an attached sidecar has not connected, so the owner can cancel the wait. */
  const active = computed(() => status.value.state === 'starting' || status.value.state === 'running')
  const waiting = computed(() => status.value.state === 'starting')
  const errorMessage = computed(() => switchError.value ?? status.value.lastError)

  function applyStatus(next: ElectronStageSidecarStatus) {
    status.value = next
    syncUnityStageRenderer(settingsStore, next)
  }

  async function stopIfActive() {
    if (active.value)
      applyStatus(await stop())
  }

  async function toggle() {
    switching.value = true
    switchError.value = undefined

    try {
      if (active.value) {
        applyStatus(await stop())
        return
      }

      await stopOtherStage()
      applyStatus(await start())
    }
    catch (error) {
      switchError.value = errorMessageFrom(error) ?? 'Failed to switch the Unity stage.'
      applyStatus(await getStatus())
    }
    finally {
      switching.value = false
    }
  }

  const disposeStatusListener = context.value.on(unityStageStatusChanged, (event) => {
    if (event.body)
      applyStatus(event.body)
  })

  void getStatus()
    .then(applyStatus)
    .catch((error) => {
      switchError.value = errorMessageFrom(error) ?? 'Failed to read the Unity stage status.'
    })

  onScopeDispose(() => disposeStatusListener?.())

  return { active, errorMessage, stopIfActive, switching, toggle, waiting }
}
