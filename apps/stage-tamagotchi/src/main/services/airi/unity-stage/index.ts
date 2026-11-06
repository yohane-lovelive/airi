import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type { BrowserWindow } from 'electron'

import type { ElectronStageSidecarStatus } from '../../../../shared/eventa'
import type {
  UnityStageClipInput,
  UnityStagePmxPackageInput,
  UnityStageSceneInput,
  UnityStageVrmaGestureInput,
} from '../../../../shared/eventa/unity-stage'
import type { StageSidecarLaunch } from '../stage-sidecar'

import process from 'node:process'

import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import { parseHostMessage } from '@proj-airi/stage-shared/stage-sidecar'
import { app } from 'electron'
import { array, instance, nonEmpty, object, pipe, regex, safeParse, string } from 'valibot'

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
} from '../../../../shared/eventa/unity-stage'
import { onAppBeforeQuit } from '../../../libs/bootkit/lifecycle'
import { createStageSidecarHost, materializeFile, materializePackage, parseSceneInput } from '../stage-sidecar'

type MainContext = ReturnType<typeof createContext>['context']

const pmxPackageSchema = object({
  files: array(object({ data: instance(Uint8Array), path: string() })),
  modelId: pipe(string(), nonEmpty()),
  modelPath: pipe(string(), regex(/\.pmx$/i, 'The model of a PMX package must be a PMX file.')),
  name: pipe(string(), nonEmpty()),
})

/**
 * The Unity display sidecar, owned by Electron main.
 *
 * `applySceneInput`, `applyPmxPackage`, `applyIdle`, and `playVrmaGesture` write files, so they wait for the lifecycle lock. `sendSignal`
 * does not wait, and it drops a signal while the stage is not running, because a late signal has no value.
 */
export interface UnityStageManager {
  applyIdle: (payload: UnityStageClipInput) => Promise<void>
  applyPmxPackage: (payload: UnityStagePmxPackageInput) => Promise<void>
  applySceneInput: (payload: UnityStageSceneInput) => Promise<void>
  getStatus: () => ElectronStageSidecarStatus
  playVrmaGesture: (payload: UnityStageVrmaGestureInput) => Promise<void>
  reportError: (message: string) => void
  sendSignal: (signal: unknown) => void
  start: () => Promise<ElectronStageSidecarStatus>
  stop: () => Promise<ElectronStageSidecarStatus>
  subscribe: (callback: (status: ElectronStageSidecarStatus) => void) => () => void
}

/**
 * Creates the Unity stage manager.
 *
 * Call stack:
 *
 * setupUnityStageManager
 *   -> {@link createUnityStageManager}
 *     -> {@link createUnityStageService} (renderer invokes)
 *       -> {@link createStageSidecarHost}
 */
export function createUnityStageManager(): UnityStageManager {
  const log = useLogg('main/unity-stage').useGlobalConfig()

  const host = createStageSidecarHost({
    label: 'Unity stage',
    name: 'unity-stage',
    onMessage: (message) => {
      if (message.type === 'character.error') {
        log.withFields({ payload: message.payload }).warn('Unity stage refused a signal')
        return true
      }

      return message.type === 'scene.applied'
    },
    resolveLaunch: resolveUnityStageLaunch,
  })

  /** Sends a message that follows a file write, so a sidecar that left during the write gives a clear error. */
  function sendAfterWrite(value: unknown) {
    if (!sendHostMessage(value))
      throw new Error('Unity stage bridge is not connected.')
  }

  function sendHostMessage(value: unknown) {
    const message = parseHostMessage(value)
    return host.send(message.type, 'payload' in message ? message.payload : undefined)
  }

  function assertRunning() {
    if (host.getStatus().state !== 'running')
      throw new Error('Unity stage is not running.')
  }

  /**
   * Removes the copies of the models. The stored ZIP stays the source, and each selection writes its copy again, so a
   * copy has no value after its session. Without this step, the folder grows with each model that the owner selects.
   */
  async function removeModelCopies() {
    try {
      await rm(modelsDirectory(), { force: true, recursive: true })
    }
    catch (error) {
      log.withFields({ error: errorMessageFrom(error) }).warn('could not remove the Unity stage model copies')
    }
  }

  return {
    async applyIdle(payload) {
      await host.runExclusive(async () => {
        assertRunning()
        const path = await materializeFile(clipDirectory(), `${payload.id}.vrma`, payload.data)
        sendAfterWrite({ type: 'host.character.idle', payload: { path } })
      })
    },
    async applyPmxPackage(payload) {
      await host.runExclusive(async () => {
        assertRunning()

        const result = safeParse(pmxPackageSchema, payload)
        if (!result.success)
          throw new Error('Invalid Unity stage PMX package payload.')

        const { files, modelId, modelPath, name } = result.output
        const path = await materializePackage(modelDirectory(modelId), files, modelPath)

        sendAfterWrite({
          type: 'host.scene.apply',
          payload: { format: 'pmx', modelId, name, path },
        })
      })
    },
    async applySceneInput(payload) {
      await host.runExclusive(async () => {
        assertRunning()

        const sceneInput = parseSceneInput(payload, 'Invalid Unity stage scene input payload.')
        const path = await materializeFile(
          modelDirectory(sceneInput.modelId),
          sceneInput.fileName,
          sceneInput.data,
        )

        sendAfterWrite({
          type: 'host.scene.apply',
          payload: {
            format: sceneInput.format,
            modelId: sceneInput.modelId,
            name: sceneInput.name,
            path,
          },
        })
      })
    },
    getStatus: host.getStatus,
    async playVrmaGesture(payload) {
      await host.runExclusive(async () => {
        assertRunning()

        const path = await materializeFile(clipDirectory(), `${payload.id}.vrma`, payload.data)
        sendAfterWrite({
          type: 'host.character.gesture',
          payload: { kind: 'vrma', id: payload.id, part: payload.part, path },
        })
      })
    },
    reportError: host.reportError,
    sendSignal(signal) {
      if (host.getStatus().state !== 'running')
        return

      try {
        sendHostMessage(signal)
      }
      catch (error) {
        log.withFields({ error: errorMessageFrom(error) }).warn('dropped an invalid Unity stage signal')
      }
    },
    async start() {
      // A quit or a crash skips `stop`. A running sidecar can still read its files, so its copies stay.
      if (host.getStatus().state !== 'running' && host.getStatus().state !== 'starting')
        await removeModelCopies()

      return host.start()
    },
    async stop() {
      const status = await host.stop()
      // An old file names a socket that no longer exists, so an Editor must not find it.
      await rm(attachFilePath(), { force: true })
      await removeModelCopies()
      return status
    },
    subscribe: host.subscribe,
  }
}

/**
 * Registers the invoke handlers for one Electron window context.
 *
 * Call stack:
 *
 * createUnityStageService
 *   -> renderer invoke/eventa handlers
 *     -> {@link UnityStageManager}
 */
export function createUnityStageService(params: {
  context: MainContext
  manager: UnityStageManager
  window: BrowserWindow
}) {
  const cleanups: Array<() => void> = [
    params.manager.subscribe((status) => {
      if (!params.window.isDestroyed())
        params.context.emit(unityStageStatusChanged, status)
    }),
    defineInvokeHandler(params.context, unityStageStart, () => params.manager.start()),
    defineInvokeHandler(params.context, unityStageStop, () => params.manager.stop()),
    defineInvokeHandler(params.context, unityStageGetStatus, () => params.manager.getStatus()),
    defineInvokeHandler(params.context, unityStageApplySceneInput, payload => params.manager.applySceneInput(payload)),
    defineInvokeHandler(params.context, unityStageApplyPmxPackage, payload => params.manager.applyPmxPackage(payload)),
    defineInvokeHandler(params.context, unityStageApplyIdle, payload => params.manager.applyIdle(payload)),
    defineInvokeHandler(params.context, unityStagePlayVrmaGesture, payload => params.manager.playVrmaGesture(payload)),
    defineInvokeHandler(params.context, unityStageReportError, message => params.manager.reportError(message)),
    params.context.on(unityStageSignal, event => params.manager.sendSignal(event.body)),
  ]

  const cleanup = () => {
    for (const fn of cleanups)
      fn()
  }

  params.window.on('closed', cleanup)
  return cleanup
}

/** Creates the app-wide manager, and stops the sidecar when the app quits. */
export function setupUnityStageManager() {
  const manager = createUnityStageManager()

  onAppBeforeQuit(async () => {
    await manager.stop()
  })

  return manager
}

function resolveUnityStageStorageRoot() {
  return join(app.getPath('userData'), 'unity-stage')
}

function attachFilePath() {
  return join(resolveUnityStageStorageRoot(), 'attach.json')
}

function clipDirectory() {
  return join(resolveUnityStageStorageRoot(), 'clips')
}

/**
 * Gives the directory of one model. The ID comes from a renderer, so each character outside a safe set becomes `_`, and
 * an ID cannot leave the directory.
 *
 * @example
 * modelDirectory('../a/b')
 * // => '<userData>/unity-stage/models/___a_b'
 */
function modelDirectory(modelId: string) {
  return join(modelsDirectory(), modelId.replace(/[^\w-]/g, '_') || 'model')
}

function modelsDirectory() {
  return join(resolveUnityStageStorageRoot(), 'models')
}

/**
 * Chooses how the sidecar connects.
 *
 * Precedence:
 * 1. `AIRI_UNITY_STAGE_ATTACH`: work in the Editor. It comes first, so a developer with a built player can still attach.
 * 2. `AIRI_UNITY_STAGE_EXECUTABLE`: a built player.
 *
 * A packaged app has neither at this time. Step U5 of the ADR adds the packaging.
 */
async function resolveUnityStageLaunch(websocketUrl: string): Promise<StageSidecarLaunch> {
  if (app.isPackaged)
    throw new Error('Unity Stage is available only in development at this time.')

  if (['1', 'on', 'true', 'yes'].includes((process.env.AIRI_UNITY_STAGE_ATTACH ?? '').trim().toLowerCase())) {
    await mkdir(resolveUnityStageStorageRoot(), { recursive: true })
    await writeFile(attachFilePath(), JSON.stringify({ url: websocketUrl }))
    return { kind: 'attach' }
  }

  const executable = process.env.AIRI_UNITY_STAGE_EXECUTABLE?.trim()
  if (!executable) {
    throw new Error(
      'Unity Stage needs one of two environment variables. Set it, then restart the Electron dev app.\n'
      + 'AIRI_UNITY_STAGE_ATTACH=1: wait for Play mode in the Unity Editor.\n'
      + 'AIRI_UNITY_STAGE_EXECUTABLE: the absolute path of a built player.',
    )
  }

  await assertExecutableFile(executable)

  return {
    args: [`--airi-ws-url=${websocketUrl}`],
    env: process.env,
    executable,
    kind: 'process',
  }
}

async function assertExecutableFile(executable: string) {
  let isFile = false
  try {
    isFile = (await stat(executable)).isFile()
  }
  catch (error) {
    throw new Error(`AIRI_UNITY_STAGE_EXECUTABLE points to a missing file: ${executable}\n${errorMessageFrom(error) ?? ''}`.trim())
  }

  if (!isFile)
    throw new Error(`AIRI_UNITY_STAGE_EXECUTABLE must point to a file: ${executable}`)
}
