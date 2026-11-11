import type { createContext } from '@moeru/eventa'
import type { DisplayModel } from '@proj-airi/stage-ui/stores/display-models'

import type { ElectronStageSidecarStatus } from '../../shared/eventa'
import type { UnityStageClipInput, UnityStagePmxPackageInput, UnityStageSceneInput, UnityStageSignal, UnityStageVrmaGestureInput } from '../../shared/eventa/unity-stage'

import JSZip from 'jszip'

import { defineInvokeHandler } from '@moeru/eventa'
import { BUILT_IN_GESTURES } from '@proj-airi/stage-shared/body-motion'
import { parseHostMessage } from '@proj-airi/stage-shared/stage-sidecar'
import { DisplayModelFormat } from '@proj-airi/stage-ui/stores/display-models'
import { useSettings } from '@proj-airi/stage-ui/stores/settings'
import { useStageSidecarStore } from '@proj-airi/stage-ui/stores/stage-sidecar'
import { createPinia, disposePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { render } from 'vitest-browser-vue'
import { defineComponent, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'

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
import { useUnityStageBridge, useUnityStageSwitch } from './unity-stage'

/** The type arguments make the context invocable, so `defineInvokeHandler` accepts it. */
type MemoryContext = ReturnType<typeof createContext<unknown, { raw?: unknown }>>

const mocks = vi.hoisted(() => ({
  context: undefined as MemoryContext | undefined,
}))

// NOTICE:
// The Unity service runs in the Electron main process. An in-memory Eventa context carries the same events and invokes,
// and the handlers below answer for the service. `services/airi/unity-stage/index.test.ts` covers the other side.
// Removal condition: browser tests running inside an Electron renderer.
vi.mock('@proj-airi/electron-vueuse', async () => {
  const { createContext, defineInvoke } = await import('@moeru/eventa')
  const { shallowRef } = await import('vue')
  mocks.context = createContext()
  return {
    useElectronEventaContext: () => shallowRef(mocks.context),
    useElectronEventaInvoke: (event: Parameters<typeof defineInvoke>[1]) => defineInvoke(mocks.context!, event),
  }
})

function statusOf(state: ElectronStageSidecarStatus['state'], lastError?: string): ElectronStageSidecarStatus {
  return { state, pid: null, updatedAt: 1, ...(lastError ? { lastError } : {}) }
}

function vrmModel(id = 'model-1'): DisplayModel {
  return {
    format: DisplayModelFormat.VRM,
    id,
    importedAt: 0,
    name: 'Model',
    type: 'file',
    file: new File([new Uint8Array([1, 2, 3])], `${id}.vrm`),
  } as DisplayModel
}

/** A stored MMD model, as the model selector keeps it: a ZIP with UTF-8 names. */
async function mmdModel(files: Record<string, number[]>): Promise<DisplayModel> {
  const zip = new JSZip()
  for (const [path, data] of Object.entries(files))
    zip.file(path, new Uint8Array(data))

  return {
    format: DisplayModelFormat.PMXZip,
    id: 'mmd-1',
    importedAt: 0,
    name: 'MMD',
    type: 'file',
    file: new File([await zip.generateAsync({ type: 'blob' })], 'mmd.zip'),
  } as DisplayModel
}

function emitStatus(status: ElectronStageSidecarStatus) {
  mocks.context!.emit(unityStageStatusChanged, status)
}

describe('the Unity stage in the renderer', () => {
  let signals: UnityStageSignal[] = []
  let idles: UnityStageClipInput[] = []
  let scenes: UnityStageSceneInput[] = []
  let packages: UnityStagePmxPackageInput[] = []
  let gestures: UnityStageVrmaGestureInput[] = []
  let errors: string[] = []
  let order: string[] = []
  let initialStatus = statusOf('stopped')
  const start = vi.fn<() => ElectronStageSidecarStatus>()
  const stop = vi.fn<() => ElectronStageSidecarStatus>()
  const playVrma = vi.fn<(payload: UnityStageVrmaGestureInput) => void>()
  let cleanups: (() => void)[] = []

  beforeEach(() => {
    signals = []
    idles = []
    scenes = []
    packages = []
    gestures = []
    errors = []
    order = []
    initialStatus = statusOf('stopped')
    start.mockReset().mockReturnValue(statusOf('running'))
    stop.mockReset().mockReturnValue(statusOf('stopped'))
    playVrma.mockReset().mockImplementation(payload => void gestures.push(payload))

    const context = mocks.context!
    const offSignal = context.on(unityStageSignal, (event) => {
      signals.push(event.body!)
    })
    cleanups = [
      () => offSignal?.(),
      defineInvokeHandler(context, unityStageGetStatus, () => initialStatus),
      defineInvokeHandler(context, unityStageApplyIdle, (payload) => {
        order.push('idle')
        idles.push(payload)
      }),
      defineInvokeHandler(context, unityStageApplySceneInput, (payload) => {
        order.push('scene')
        scenes.push(payload)
      }),
      defineInvokeHandler(context, unityStageApplyPmxPackage, (payload) => {
        order.push('package')
        packages.push(payload)
      }),
      defineInvokeHandler(context, unityStagePlayVrmaGesture, payload => playVrma(payload)),
      defineInvokeHandler(context, unityStageReportError, (message) => {
        errors.push(message)
      }),
      defineInvokeHandler(context, unityStageStart, () => start()),
      defineInvokeHandler(context, unityStageStop, () => stop()),
    ]
  })

  afterEach(() => {
    cleanups.forEach(cleanup => cleanup())
  })

  async function mount<T>(setup: () => T) {
    const pinia = createPinia()
    let exposed!: T
    const screen = await render(defineComponent({
      setup() {
        exposed = setup()
        return () => null
      },
    }), { global: { plugins: [pinia, createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false })] } })
    onTestFinished(() => {
      screen.unmount()
      disposePinia(pinia)
    })
    await nextTick()
    return { exposed, screen, settings: useSettings(), sidecar: useStageSidecarStore() }
  }

  describe('useUnityStageBridge', () => {
    it('sends an expression with its hold', async () => {
      const { sidecar } = await mount(useUnityStageBridge)

      sidecar.setExpression('happy', 0.75, 2500)

      await vi.waitFor(() => expect(signals).toHaveLength(1))
      expect(signals[0]).toEqual({ type: 'host.character.expression', payload: { name: 'happy', intensity: 0.75, holdMs: 2500 } })
    })

    it('leaves the hold to the sidecar when it has no value', async () => {
      const { sidecar } = await mount(useUnityStageBridge)

      sidecar.setExpression('happy', 1)

      await vi.waitFor(() => expect(signals).toHaveLength(1))
      expect(signals[0].payload).toEqual({ name: 'happy', intensity: 1 })
    })

    it('sends a frame', async () => {
      const { sidecar } = await mount(useUnityStageBridge)
      const rest = { x: 0, y: 0, z: 0 }
      const frame = {
        mouth: { A: 0.5, E: 0, I: 0, O: 0, U: 0 },
        bones: { spine: rest, chest: rest, neck: rest, head: rest },
        eyes: { yaw: 0, pitch: 0 },
      }

      sidecar.sendFrame(frame)

      await vi.waitFor(() => expect(signals).toHaveLength(1))
      expect(signals[0]).toEqual({ type: 'host.character.frame', payload: frame })
    })

    it('sends an attention in a form that the protocol accepts', async () => {
      const { sidecar } = await mount(useUnityStageBridge)

      sidecar.setAttention('viewer')

      await vi.waitFor(() => expect(signals).toHaveLength(1))
      expect(signals[0]).toEqual({ type: 'host.character.attention', payload: { target: 'viewer' } })
      expect(() => parseHostMessage(signals[0])).not.toThrow()
    })

    it('sends a viewer attention again to a sidecar that comes back', async () => {
      const { sidecar } = await mount(useUnityStageBridge)
      emitStatus(statusOf('running'))
      sidecar.setAttention('viewer')
      await vi.waitFor(() => expect(signals).toHaveLength(1))

      emitStatus(statusOf('starting'))
      await nextTick()
      emitStatus(statusOf('running'))

      await vi.waitFor(() => expect(signals).toHaveLength(2))
      expect(signals[1]).toEqual({ type: 'host.character.attention', payload: { target: 'viewer' } })
    })

    it('does not send a released attention to a sidecar that comes back', async () => {
      const { sidecar } = await mount(useUnityStageBridge)
      emitStatus(statusOf('running'))
      sidecar.setAttention('viewer')
      sidecar.setAttention('none')
      await vi.waitFor(() => expect(signals).toHaveLength(2))

      emitStatus(statusOf('starting'))
      await nextTick()
      emitStatus(statusOf('running'))
      await nextTick()
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(signals).toHaveLength(2)
    })

    it('sends an activity in a form that the protocol accepts', async () => {
      const { sidecar } = await mount(useUnityStageBridge)

      sidecar.setActivity('watching-screen')

      await vi.waitFor(() => expect(signals).toHaveLength(1))
      expect(signals[0]).toEqual({ type: 'host.character.activity', payload: { activity: 'watching-screen' } })
      expect(() => parseHostMessage(signals[0])).not.toThrow()
    })

    it('sends a watching-screen activity again to a sidecar that comes back', async () => {
      const { sidecar } = await mount(useUnityStageBridge)
      emitStatus(statusOf('running'))
      sidecar.setActivity('watching-screen')
      await vi.waitFor(() => expect(signals).toHaveLength(1))

      emitStatus(statusOf('starting'))
      await nextTick()
      emitStatus(statusOf('running'))

      await vi.waitFor(() => expect(signals).toHaveLength(2))
      expect(signals[1]).toEqual({ type: 'host.character.activity', payload: { activity: 'watching-screen' } })
    })

    it('does not send an ended activity to a sidecar that comes back', async () => {
      const { sidecar } = await mount(useUnityStageBridge)
      emitStatus(statusOf('running'))
      sidecar.setActivity('watching-screen')
      sidecar.setActivity('none')
      await vi.waitFor(() => expect(signals).toHaveLength(2))

      emitStatus(statusOf('starting'))
      await nextTick()
      emitStatus(statusOf('running'))
      await nextTick()
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(signals).toHaveLength(2)
    })

    it.each(BUILT_IN_GESTURES.map(gesture => [gesture.id, gesture] as const))('sends the built-in gesture %s in a form that the protocol accepts', async (id, gesture) => {
      const { sidecar } = await mount(useUnityStageBridge)

      await expect(sidecar.playGesture({ kind: 'keys', id, part: 'upper', gesture })).resolves.toBe(true)

      await vi.waitFor(() => expect(signals).toHaveLength(1))
      expect(() => parseHostMessage(signals[0])).not.toThrow()
    })

    it('sends the bytes of a clip through the invoke that writes the file', async () => {
      const { sidecar } = await mount(useUnityStageBridge)

      const played = await sidecar.playGesture({ kind: 'vrma', id: 'dance', part: 'full', vrma: new Uint8Array([7, 8]).buffer })

      expect(played).toBe(true)
      expect(gestures).toHaveLength(1)
      expect(gestures[0].id).toBe('dance')
      expect(gestures[0].part).toBe('full')
      expect([...gestures[0].data]).toEqual([7, 8])
    })

    it('reports that a clip did not play when the invoke fails', async () => {
      playVrma.mockImplementation(() => {
        throw new Error('Unity stage is not running.')
      })
      const { sidecar } = await mount(useUnityStageBridge)

      const played = await sidecar.playGesture({ kind: 'vrma', id: 'dance', part: 'full', vrma: new Uint8Array([7]).buffer })

      expect(played).toBe(false)
    })

    it('sends the idle and then the model when the sidecar runs', async () => {
      const { settings } = await mount(useUnityStageBridge)
      settings.stageModelSelectedDisplayModel = vrmModel()

      emitStatus(statusOf('running'))

      await vi.waitFor(() => expect(scenes).toHaveLength(1))
      expect(order).toEqual(['idle', 'scene'])
      expect(idles[0].id).toBe('idle-loop')
      expect(idles[0].data.byteLength).toBeGreaterThan(0)
      expect(scenes[0].modelId).toBe('model-1')
      expect(scenes[0].format).toBe('vrm')
      expect(scenes[0].fileName).toBe('model-1.vrm')
      expect([...scenes[0].data]).toEqual([1, 2, 3])
    })

    it('sends a new model while Settings is closed, because this bridge lives on the stage page', async () => {
      const { settings } = await mount(useUnityStageBridge)
      settings.stageModelSelectedDisplayModel = vrmModel()
      emitStatus(statusOf('running'))
      await vi.waitFor(() => expect(scenes).toHaveLength(1))

      settings.stageModelSelectedDisplayModel = vrmModel('model-2')

      await vi.waitFor(() => expect(scenes).toHaveLength(2))
      expect(scenes[1].modelId).toBe('model-2')
    })

    // Found in the live check of step U1: one change of the model sent the model two times and the idle three times.
    //
    // ROOT CAUSE:
    //
    // The watcher had an array of sources, and one of them was a shallowRef. Vue then sets `forceTrigger` for the array
    // (`doWatch` in @vue/reactivity), so the callback ran on each trigger of a source, also with no changed value.
    //
    // We fixed this by watching one computed scalar, the ID of the model that the sidecar must show.
    it('does not send the model again when the same model is set again', async () => {
      const { settings } = await mount(useUnityStageBridge)
      const model = vrmModel()
      settings.stageModelSelectedDisplayModel = model
      emitStatus(statusOf('running'))
      await vi.waitFor(() => expect(scenes).toHaveLength(1))

      settings.stageModelSelectedDisplayModel = { ...model }
      await nextTick()
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(scenes).toHaveLength(1)
      expect(idles).toHaveLength(1)
    })

    it('sends the model again to a sidecar that comes back', async () => {
      const { settings } = await mount(useUnityStageBridge)
      settings.stageModelSelectedDisplayModel = vrmModel()
      emitStatus(statusOf('running'))
      await vi.waitFor(() => expect(scenes).toHaveLength(1))

      emitStatus(statusOf('starting'))
      await nextTick()
      emitStatus(statusOf('running'))

      await vi.waitFor(() => expect(scenes).toHaveLength(2))
    })

    it('reports a model format that the sidecar cannot load, and sends nothing', async () => {
      const { settings } = await mount(useUnityStageBridge)
      settings.stageModelSelectedDisplayModel = { ...vrmModel(), format: DisplayModelFormat.Live2dZip } as DisplayModel

      emitStatus(statusOf('running'))

      await vi.waitFor(() => expect(errors).toEqual(['tamagotchi.settings.pages.models.unity-stage.unsupported-model']))
      expect(idles).toEqual([])
      expect(scenes).toEqual([])
      expect(packages).toEqual([])
    })

    it('sends a PMX package with its folders', async () => {
      const { settings } = await mount(useUnityStageBridge)
      settings.stageModelSelectedDisplayModel = await mmdModel({
        'モデル/結月.pmx': [1, 2],
        'モデル/tex/顔.png': [3],
      })

      emitStatus(statusOf('running'))

      await vi.waitFor(() => expect(packages).toHaveLength(1))
      expect(packages[0].modelId).toBe('mmd-1')
      expect(packages[0].name).toBe('MMD')
      expect(packages[0].modelPath).toBe('モデル/結月.pmx')
      expect(packages[0].files.map(file => [file.path, [...file.data]])).toEqual([
        ['モデル/結月.pmx', [1, 2]],
        ['モデル/tex/顔.png', [3]],
      ])
      expect(scenes).toEqual([])
      expect(errors).toEqual([])
    })

    it('sends the first model of a package, as the three.js stage does', async () => {
      const { settings } = await mount(useUnityStageBridge)
      settings.stageModelSelectedDisplayModel = await mmdModel({ 'z.pmx': [1], 'a.pmx': [2] })

      emitStatus(statusOf('running'))

      await vi.waitFor(() => expect(packages).toHaveLength(1))
      expect(packages[0].modelPath).toBe('z.pmx')
    })

    it.each([
      ['a PMD model', { 'a.pmd': [1], 'tex.png': [2] }],
      ['no model', { 'tex.png': [2] }],
    ])('reports a package with %s, and sends nothing', async (_name, files) => {
      const { settings } = await mount(useUnityStageBridge)
      settings.stageModelSelectedDisplayModel = await mmdModel(files)

      emitStatus(statusOf('running'))

      await vi.waitFor(() => expect(errors).toEqual(['tamagotchi.settings.pages.models.unity-stage.unsupported-model']))
      expect(packages).toEqual([])
    })

    it('reports a file that is not a ZIP', async () => {
      const { settings } = await mount(useUnityStageBridge)
      settings.stageModelSelectedDisplayModel = {
        ...vrmModel(),
        format: DisplayModelFormat.PMXZip,
        file: new File([new Uint8Array([1, 2, 3])], 'broken.zip'),
      } as DisplayModel

      emitStatus(statusOf('running'))

      await vi.waitFor(() => expect(errors).toHaveLength(1))
      expect(errors[0]).not.toBe('tamagotchi.settings.pages.models.unity-stage.unsupported-model')
      expect(packages).toEqual([])
    })

    it('does not send a model before the sidecar runs', async () => {
      const { settings } = await mount(useUnityStageBridge)
      settings.stageModelSelectedDisplayModel = vrmModel()

      emitStatus(statusOf('starting'))
      await nextTick()

      expect(idles).toEqual([])
      expect(scenes).toEqual([])
    })

    it('follows a sidecar that already runs after a reload of the page', async () => {
      initialStatus = statusOf('running')

      const { settings } = await mount(useUnityStageBridge)

      await vi.waitFor(() => expect(settings.stageModelRenderer).toBe('unity'))
    })

    it('keeps the renderer while an attached sidecar leaves, and restores it after the stop', async () => {
      const { settings } = await mount(useUnityStageBridge)
      settings.setStageModelRenderer('vrm')
      settings.restoreBuiltInStageModelRenderer()
      const builtIn = settings.stageModelRenderer

      emitStatus(statusOf('running'))
      await vi.waitFor(() => expect(settings.stageModelRenderer).toBe('unity'))

      emitStatus(statusOf('starting'))
      await nextTick()
      expect(settings.stageModelRenderer).toBe('unity')

      emitStatus(statusOf('stopped'))
      await vi.waitFor(() => expect(settings.stageModelRenderer).toBe(builtIn))
    })

    it('removes the output when the page goes away', async () => {
      const { screen, sidecar } = await mount(useUnityStageBridge)

      screen.unmount()
      sidecar.setExpression('happy', 1)
      await nextTick()

      expect(signals).toEqual([])
    })
  })

  describe('useUnityStageSwitch', () => {
    it('stops the other stage before it starts, and reports the state', async () => {
      const calls: string[] = []
      const stopOther = vi.fn(async () => {
        calls.push('stop-other')
      })
      start.mockImplementation(() => {
        calls.push('start')
        return statusOf('running')
      })
      const { exposed } = await mount(() => useUnityStageSwitch(stopOther))

      await exposed.toggle()

      expect(calls).toEqual(['stop-other', 'start'])
      expect(exposed.active.value).toBe(true)
      expect(exposed.waiting.value).toBe(false)
    })

    it('stops the sidecar on the second press', async () => {
      const stopOther = vi.fn(async () => {})
      const { exposed } = await mount(() => useUnityStageSwitch(stopOther))
      await exposed.toggle()

      await exposed.toggle()

      expect(stop).toHaveBeenCalledTimes(1)
      expect(stopOther).toHaveBeenCalledTimes(1)
      expect(exposed.active.value).toBe(false)
    })

    it('shows the wait for an Editor, and lets the owner cancel it', async () => {
      start.mockReturnValue(statusOf('starting'))
      const { exposed } = await mount(() => useUnityStageSwitch(async () => {}))

      await exposed.toggle()
      expect(exposed.waiting.value).toBe(true)
      expect(exposed.active.value).toBe(true)

      await exposed.toggle()
      expect(stop).toHaveBeenCalledTimes(1)
      expect(exposed.active.value).toBe(false)
    })

    it('shows why a start failed', async () => {
      start.mockImplementation(() => {
        throw new Error('Unity Stage needs one of two environment variables.')
      })
      const { exposed } = await mount(() => useUnityStageSwitch(async () => {}))

      await exposed.toggle()

      expect(exposed.errorMessage.value).toContain('Unity Stage needs one of two environment variables.')
      expect(exposed.active.value).toBe(false)
      expect(exposed.switching.value).toBe(false)
    })

    it('shows a failure that the status reports later', async () => {
      const { exposed } = await mount(() => useUnityStageSwitch(async () => {}))

      emitStatus(statusOf('running', 'The file is broken.'))

      await vi.waitFor(() => expect(exposed.errorMessage.value).toBe('The file is broken.'))
    })
  })
})
