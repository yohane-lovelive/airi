import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type {
  StageViewErrorPayload,
  StageViewPatch,
  StageViewRequestAckPayload,
  StageViewSnapshotPayload,
} from '@proj-airi/stage-shared/godot-stage'
import type { BrowserWindow } from 'electron'

import type {
  ElectronGodotStageSceneInputPayload,
  ElectronGodotStageStatus,
} from '../../../../shared/eventa'
import type { StageSidecarEnvelope } from '../stage-sidecar'

import process from 'node:process'

import { randomUUID } from 'node:crypto'
import { access, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import {
  parseStageViewErrorPayload,
  parseStageViewPatchPayload,
  parseStageViewSnapshotPayload,
} from '@proj-airi/stage-shared/godot-stage'
import { app } from 'electron'

import {
  electronGodotStageApplySceneInput,
  electronGodotStageApplyViewPatch,
  electronGodotStageGetStatus,
  electronGodotStageGetViewSnapshot,
  electronGodotStageRequestViewSnapshot,
  electronGodotStageStart,
  electronGodotStageStatusChanged,
  electronGodotStageStop,
  electronGodotStageViewSnapshotChanged,
  electronGodotStageViewStateError,
} from '../../../../shared/eventa'
import { onAppBeforeQuit } from '../../../libs/bootkit/lifecycle'
import { getElectronMainDirname } from '../../../libs/electron/location'
import { createListenerChannel, createStageSidecarHost, materializeFile, parseSceneInput } from '../stage-sidecar'

type MainContext = ReturnType<typeof createContext>['context']

const DEFAULT_GODOT_REMOTE_DEBUG_URI = 'tcp://127.0.0.1:6007'

/**
 * Godot sidecar lifecycle controller owned by Electron main.
 *
 * Use when:
 * - Renderer windows need to start or stop the external Godot stage
 * - The selected model should be materialized and forwarded to the Godot runtime
 *
 * Expects:
 * - Production: pre-exported binary in `extraResources/godot-stage/`
 * - Dev: `GODOT4` env var points to a local Godot 4.x .NET/Mono executable
 * - The current workspace contains `engines/stage-tamagotchi-godot/project.godot` (dev mode only)
 *
 * Returns:
 * - Lifecycle helpers, scene-input forwarding, and status subscriptions
 */
export interface GodotStageManager {
  applySceneInput: (payload: ElectronGodotStageSceneInputPayload) => Promise<void>
  applyViewPatch: (payload: StageViewPatch) => Promise<StageViewRequestAckPayload>
  getStatus: () => ElectronGodotStageStatus
  getViewSnapshot: () => null | StageViewSnapshotPayload
  requestViewSnapshot: () => Promise<StageViewRequestAckPayload>
  start: () => Promise<ElectronGodotStageStatus>
  stop: () => Promise<ElectronGodotStageStatus>
  subscribe: (callback: (status: ElectronGodotStageStatus) => void) => () => void
  subscribeViewError: (callback: (payload: StageViewErrorPayload) => void) => () => void
  subscribeViewSnapshot: (callback: (snapshot: StageViewSnapshotPayload) => void) => () => void
}

interface GodotBinaryResolution {
  executable: string
  mode: 'engine' | 'exported'
}

/**
 * Creates the shared Godot stage manager. The lifecycle lives in {@link createStageSidecarHost}. This manager adds the
 * launch arguments of Godot, its model path, and its view state.
 *
 * Call stack:
 *
 * setupGodotStageManager
 *   -> {@link createGodotStageManager}
 *     -> renderer invoke handlers
 *       -> {@link createStageSidecarHost}
 */
export function createGodotStageManager(): GodotStageManager {
  const log = useLogg('main/godot-stage').useGlobalConfig()
  const viewErrorListeners = createListenerChannel<StageViewErrorPayload>(
    error => log.withError(error).warn('failed to publish Godot stage view-state error'),
  )
  const viewSnapshotListeners = createListenerChannel<StageViewSnapshotPayload>(
    error => log.withError(error).warn('failed to publish Godot stage view-state snapshot'),
  )
  let currentViewSnapshot: null | StageViewSnapshotPayload = null

  function broadcastInvalidViewPayloadError(error: unknown) {
    viewErrorListeners.publish({
      code: 'invalid-payload',
      message: errorMessageFrom(error) ?? 'Invalid Godot stage view-state payload.',
    })
  }

  function handleViewMessage(message: StageSidecarEnvelope) {
    switch (message.type) {
      case 'stage.view.error': {
        try {
          viewErrorListeners.publish(parseStageViewErrorPayload(message.payload))
        }
        catch (error) {
          broadcastInvalidViewPayloadError(error)
        }
        return true
      }
      case 'stage.view.snapshot': {
        try {
          currentViewSnapshot = parseStageViewSnapshotPayload(message.payload)
          viewSnapshotListeners.publish(currentViewSnapshot)
        }
        catch (error) {
          broadcastInvalidViewPayloadError(error)
        }
        return true
      }
      default: {
        return false
      }
    }
  }

  const host = createStageSidecarHost({
    label: 'Godot stage',
    name: 'godot-stage',
    onMessage: handleViewMessage,
    onSessionEnd: () => {
      currentViewSnapshot = null
    },
    resolveLaunch: async (websocketUrl) => {
      const godotBinary = await resolveGodotBinary()
      const debugLaunchOptions = resolveGodotStageDebugLaunchOptions()
      const sidecarArgs = [
        ...debugLaunchOptions.engineArgs,
        '--',
        `--airi-ws-url=${websocketUrl}`,
        `--airi-storage-root=${resolveGodotStageStorageRoot()}`,
      ]

      log.withFields({
        executable: godotBinary.executable,
        mode: godotBinary.mode,
        remoteDebugUri: debugLaunchOptions.remoteDebugUri,
      }).log('spawning Godot stage')

      if (godotBinary.mode === 'exported') {
        return {
          args: sidecarArgs,
          env: resolveGodotStageProcessEnv(),
          executable: godotBinary.executable,
          kind: 'process',
        }
      }

      const godotProjectPath = await resolveGodotProjectPath()
      return {
        args: ['--path', godotProjectPath, ...sidecarArgs],
        cwd: godotProjectPath,
        env: resolveGodotStageProcessEnv(),
        executable: godotBinary.executable,
        kind: 'process',
      }
    },
  })

  function sendViewRequest(type: 'host.view.patch' | 'host.view.request_snapshot', payload: Record<string, unknown> = {}) {
    if (host.getStatus().state !== 'running') {
      throw new Error('Godot stage is not running.')
    }

    const requestId = randomUUID()
    if (!host.send(type, { requestId, ...payload })) {
      throw new Error('Godot stage bridge is not connected.')
    }

    return { requestId }
  }

  return {
    async applySceneInput(payload) {
      await host.runExclusive(async () => {
        if (host.getStatus().state !== 'running') {
          throw new Error('Godot stage is not running.')
        }

        const sceneInput = parseSceneInput(payload, 'Invalid Godot stage scene input payload.')
        const path = await materializeFile(
          join(resolveGodotStageStorageRoot(), 'models', sceneInput.modelId),
          sceneInput.fileName,
          sceneInput.data,
        )

        if (!host.send('host.scene.apply', {
          format: sceneInput.format,
          modelId: sceneInput.modelId,
          name: sceneInput.name,
          path,
        })) {
          throw new Error('Godot stage bridge is not connected.')
        }
      })
    },
    async applyViewPatch(payload) {
      return await host.runExclusive(async () => {
        const patch = parseStageViewPatchPayload(payload)
        return sendViewRequest('host.view.patch', { patch })
      })
    },
    getStatus: host.getStatus,
    getViewSnapshot() {
      return currentViewSnapshot
    },
    async requestViewSnapshot() {
      return await host.runExclusive(async () => {
        return sendViewRequest('host.view.request_snapshot')
      })
    },
    start: host.start,
    stop: host.stop,
    subscribe: host.subscribe,
    subscribeViewError(callback) {
      return viewErrorListeners.subscribe(callback)
    },
    subscribeViewSnapshot(callback) {
      return viewSnapshotListeners.subscribe(callback)
    },
  }
}

/**
 * Registers Godot stage invoke handlers for one Electron window context.
 *
 * Call stack:
 *
 * createGodotStageService
 *   -> renderer invoke/eventa handlers
 *     -> {@link GodotStageManager}
 */
export function createGodotStageService(params: {
  context: MainContext
  manager: GodotStageManager
  window: BrowserWindow
}) {
  const unsubscribe = params.manager.subscribe((status) => {
    if (!params.window.isDestroyed()) {
      params.context.emit(electronGodotStageStatusChanged, status)
    }
  })
  const unsubscribeViewSnapshot = params.manager.subscribeViewSnapshot((snapshot) => {
    if (!params.window.isDestroyed()) {
      params.context.emit(electronGodotStageViewSnapshotChanged, snapshot)
    }
  })
  const unsubscribeViewError = params.manager.subscribeViewError((payload) => {
    if (!params.window.isDestroyed()) {
      params.context.emit(electronGodotStageViewStateError, payload)
    }
  })

  const cleanups: Array<() => void> = [
    unsubscribe,
    unsubscribeViewSnapshot,
    unsubscribeViewError,
    defineInvokeHandler(params.context, electronGodotStageStart, () => params.manager.start()),
    defineInvokeHandler(params.context, electronGodotStageStop, () => params.manager.stop()),
    defineInvokeHandler(params.context, electronGodotStageGetStatus, () => params.manager.getStatus()),
    defineInvokeHandler(params.context, electronGodotStageApplySceneInput, payload => params.manager.applySceneInput(payload)),
    defineInvokeHandler(params.context, electronGodotStageGetViewSnapshot, () => params.manager.getViewSnapshot()),
    defineInvokeHandler(params.context, electronGodotStageApplyViewPatch, payload => params.manager.applyViewPatch(payload)),
    defineInvokeHandler(params.context, electronGodotStageRequestViewSnapshot, () => params.manager.requestViewSnapshot()),
  ]

  const cleanup = () => {
    for (const fn of cleanups) {
      fn()
    }
  }

  params.window.on('closed', cleanup)
  return cleanup
}

/**
 * Creates and wires the shared Godot stage manager into app lifecycle hooks.
 *
 * Use when:
 * - Electron main needs one app-wide Godot sidecar lifecycle owner
 *
 * Expects:
 * - App shutdown to call the registered `onAppBeforeQuit` hook
 *
 * Returns:
 * - The ready-to-use Godot stage manager
 */
export function setupGodotStageManager() {
  const manager = createGodotStageManager()

  onAppBeforeQuit(async () => {
    await manager.stop()
  })

  return manager
}

// Packaged builds ship a pre-exported sidecar under Electron resources.
async function resolveExportedGodotBinary(): Promise<string | undefined> {
  const platform = process.platform
  let binaryName: string

  if (platform === 'win32') {
    binaryName = 'godot-stage.exe'
  }
  else if (platform === 'darwin') {
    binaryName = join('godot-stage.app', 'Contents', 'MacOS', 'godot-stage')
  }
  else {
    binaryName = 'godot-stage'
  }

  const binaryPath = join(process.resourcesPath, 'godot-stage', binaryName)

  try {
    await access(binaryPath)
    return binaryPath
  }
  catch {
    return undefined
  }
}

async function resolveGodotBinary(): Promise<GodotBinaryResolution> {
  if (app.isPackaged) {
    const exported = await resolveExportedGodotBinary()
    if (exported) {
      return { executable: exported, mode: 'exported' }
    }

    throw new Error(
      'Godot stage exported binary not found. '
      + `Expected at: ${join(process.resourcesPath, 'godot-stage')}`,
    )
  }

  const envPath = process.env.GODOT4?.trim()
  if (!envPath) {
    throw new Error(
      'GODOT4 is required to start Godot Stage in development mode.\n'
      + 'Set GODOT4 to the absolute path of your Godot 4.x .NET/Mono executable, then restart the Electron dev app.\n'
      + 'Examples:\n'
      + '  PowerShell: $env:GODOT4 = "C:\\Path\\To\\Godot_v4.x-stable_mono_win64.exe"\n'
      + '  Bash: export GODOT4="/path/to/godot"',
    )
  }

  await validateConfiguredGodotEnginePath(envPath)
  return { executable: envPath, mode: 'engine' }
}

// Dev builds run the Godot engine against the workspace project.godot.
async function resolveGodotProjectPath() {
  let currentDirectory = getElectronMainDirname()

  while (true) {
    const projectPath = resolve(currentDirectory, 'engines', 'stage-tamagotchi-godot')

    try {
      await access(join(projectPath, 'project.godot'))
      return projectPath
    }
    catch {}

    const parentDirectory = dirname(currentDirectory)
    if (parentDirectory === currentDirectory) {
      break
    }

    currentDirectory = parentDirectory
  }

  throw new Error(`Unable to locate engines/stage-tamagotchi-godot/project.godot from ${getElectronMainDirname()}.`)
}

function resolveGodotStageDebugLaunchOptions() {
  const remoteDebugEnabled = ['1', 'on', 'true', 'yes'].includes(
    (process.env.GODOT_STAGE_REMOTE_DEBUG ?? '').trim().toLowerCase(),
  )
  const remoteDebugUri = remoteDebugEnabled
    ? process.env.GODOT_STAGE_REMOTE_DEBUG_URI?.trim() || DEFAULT_GODOT_REMOTE_DEBUG_URI
    : undefined

  // Godot engine/debugger flags must stay before `--`; StageRoot arguments stay
  // after it and are assembled next to the WebSocket URL.
  return {
    engineArgs: remoteDebugUri ? ['--remote-debug', remoteDebugUri] : [],
    remoteDebugUri,
  }
}

function resolveGodotStageProcessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AIRI_GODOT_STAGE_DEV_MODE: app.isPackaged
      ? process.env.AIRI_GODOT_STAGE_DEV_MODE ?? '0'
      : process.env.AIRI_GODOT_STAGE_DEV_MODE ?? '1',
  }
}

function resolveGodotStageStorageRoot() {
  return join(app.getPath('userData'), 'godot-stage')
}

async function validateConfiguredGodotEnginePath(executable: string) {
  let executableStats
  try {
    executableStats = await stat(executable)
  }
  catch (error) {
    throw new Error(
      'GODOT4 points to a missing Godot executable.\n'
      + `Configured path: ${executable}\n`
      + 'Set GODOT4 to the absolute path of your Godot 4.x .NET/Mono executable before starting dev mode.\n'
      + `Original error: ${errorMessageFrom(error) ?? 'unknown error'}`,
    )
  }

  if (!executableStats.isFile()) {
    throw new Error(
      'GODOT4 must point to the Godot executable file, not a directory or app bundle.\n'
      + `Configured path: ${executable}\n`
      + 'Examples:\n'
      + '  Windows: C:\\Path\\To\\Godot_v4.x-stable_mono_win64.exe\n'
      + '  macOS: /Applications/Godot_mono.app/Contents/MacOS/Godot\n'
      + '  Linux: /path/to/Godot_v4.x-stable_mono_linux.x86_64',
    )
  }
}
