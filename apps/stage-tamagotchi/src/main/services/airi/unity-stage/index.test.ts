import type { ChildProcess, SpawnOptions } from 'node:child_process'

import type { UnityStageManager } from '.'

import process from 'node:process'

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fixtures from '../../../../../../../packages/stage-shared/src/stage-sidecar/protocol-fixtures.json'

import { createUnityStageManager } from '.'

const FAKE_SIDECAR = resolve(import.meta.dirname, '../../../../../scripts/fake-stage-sidecar.mjs')

const state = vi.hoisted(() => ({
  isPackaged: false,
  spawned: [] as { executable: string, args: string[] }[],
  userData: '',
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => state.userData,
    get isPackaged() {
      return state.isPackaged
    },
    on: vi.fn(),
    once: vi.fn(),
  },
}))

vi.mock('../../../libs/bootkit/lifecycle', () => ({ onAppBeforeQuit: vi.fn() }))

// The process and the socket stay real. Only the executable changes, because no Unity player exists on a test machine.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (executable: string, args: string[], options: SpawnOptions): ChildProcess => {
      state.spawned.push({ executable, args })
      return actual.spawn(process.execPath, [FAKE_SIDECAR, ...args], options)
    },
  }
})

describe('createUnityStageManager', () => {
  let managers: UnityStageManager[] = []
  let logPath = ''

  function createManager() {
    const manager = createUnityStageManager()
    managers.push(manager)
    return manager
  }

  function received() {
    if (!existsSync(logPath))
      return []

    return readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { type: string, payload?: Record<string, unknown> })
  }

  beforeEach(() => {
    state.isPackaged = false
    state.spawned.length = 0
    state.userData = mkdtempSync(join(tmpdir(), 'airi-unity-stage-'))
    logPath = join(state.userData, 'received.jsonl')
    vi.stubEnv('AIRI_UNITY_STAGE_ATTACH', '')
    vi.stubEnv('AIRI_UNITY_STAGE_EXECUTABLE', process.execPath)
    vi.stubEnv('FAKE_SIDECAR_LOG', logPath)
    vi.stubEnv('FAKE_SIDECAR_MODE', 'normal')
  })

  afterEach(async () => {
    await Promise.all(managers.map(manager => manager.stop().catch(() => {})))
    managers = []
    vi.unstubAllEnvs()
    rmSync(state.userData, { recursive: true, force: true })
  })

  describe('launch', () => {
    it('starts the player with the socket URL', async () => {
      const manager = createManager()

      const status = await manager.start()

      expect(status.state).toBe('running')
      expect(state.spawned[0].executable).toBe(process.execPath)
      expect(state.spawned[0].args).toHaveLength(1)
      expect(state.spawned[0].args[0]).toMatch(/^--airi-ws-url=ws:\/\/127\.0\.0\.1:\d+\/ws\?token=/)
    })

    it('explains both ways to connect when no variable is set', async () => {
      vi.stubEnv('AIRI_UNITY_STAGE_EXECUTABLE', '')
      const manager = createManager()

      await expect(manager.start()).rejects.toThrow('Unity Stage needs one of two environment variables.')

      expect(manager.getStatus().state).toBe('error')
      expect(state.spawned).toHaveLength(0)
    })

    it('refuses an executable that does not exist', async () => {
      vi.stubEnv('AIRI_UNITY_STAGE_EXECUTABLE', join(state.userData, 'missing.exe'))
      const manager = createManager()

      await expect(manager.start()).rejects.toThrow('AIRI_UNITY_STAGE_EXECUTABLE points to a missing file')
    })

    it('refuses a directory as the executable', async () => {
      vi.stubEnv('AIRI_UNITY_STAGE_EXECUTABLE', state.userData)
      const manager = createManager()

      await expect(manager.start()).rejects.toThrow('AIRI_UNITY_STAGE_EXECUTABLE must point to a file')
    })

    it('refuses to start in a packaged app', async () => {
      state.isPackaged = true
      const manager = createManager()

      await expect(manager.start()).rejects.toThrow('Unity Stage is available only in development at this time.')
    })

    it('attaches in preference to the player, through a file for the Editor', async () => {
      vi.stubEnv('AIRI_UNITY_STAGE_ATTACH', '1')
      const manager = createManager()

      const status = await manager.start()

      expect(status.state).toBe('starting')
      expect(state.spawned).toHaveLength(0)
      const attach = JSON.parse(readFileSync(join(state.userData, 'unity-stage', 'attach.json'), 'utf8'))
      expect(attach.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws\?token=/)
    })

    it('deletes the attach file when it stops, because its socket is gone', async () => {
      vi.stubEnv('AIRI_UNITY_STAGE_ATTACH', '1')
      const manager = createManager()
      await manager.start()

      await manager.stop()

      expect(existsSync(join(state.userData, 'unity-stage', 'attach.json'))).toBe(false)
    })
  })

  describe('files', () => {
    it('writes the model to disk and sends its path', async () => {
      const manager = createManager()
      await manager.start()

      await manager.applySceneInput({
        data: new Uint8Array([1, 2, 3]),
        fileName: 'dir/model.vrm',
        format: 'vrm',
        modelId: 'model-1',
        name: 'Model',
      })

      const path = join(state.userData, 'unity-stage', 'models', 'model-1', 'model.vrm')
      expect([...readFileSync(path)]).toEqual([1, 2, 3])
      await vi.waitFor(() => expect(received()).toHaveLength(1))
      expect(received()[0]).toEqual({
        type: 'host.scene.apply',
        payload: { format: 'vrm', modelId: 'model-1', name: 'Model', path },
      })
    })

    it('keeps a model ID from a renderer inside the storage directory', async () => {
      const manager = createManager()
      await manager.start()

      await manager.applySceneInput({
        data: new Uint8Array([1]),
        fileName: 'model.vrm',
        format: 'vrm',
        modelId: '../../outside',
        name: 'Model',
      })

      await vi.waitFor(() => expect(received()).toHaveLength(1))
      expect(received()[0].payload?.path).toBe(join(state.userData, 'unity-stage', 'models', '______outside', 'model.vrm'))
    })

    it('writes a PMX package with its folders and sends the path of its model', async () => {
      const manager = createManager()
      await manager.start()

      await manager.applyPmxPackage({
        files: [
          { path: 'モデル/結月.pmx', data: new Uint8Array([1]) },
          { path: 'モデル/tex/顔.png', data: new Uint8Array([2]) },
        ],
        modelId: 'model-2',
        modelPath: 'モデル/結月.pmx',
        name: 'Yukari',
      })

      const folder = join(state.userData, 'unity-stage', 'models', 'model-2', 'モデル')
      expect([...readFileSync(join(folder, 'tex', '顔.png'))]).toEqual([2])
      await vi.waitFor(() => expect(received()).toHaveLength(1))
      expect(received()[0]).toEqual({
        type: 'host.scene.apply',
        payload: { format: 'pmx', modelId: 'model-2', name: 'Yukari', path: join(folder, '結月.pmx') },
      })
    })

    it('refuses a package with a path that leaves its folder, and sends nothing', async () => {
      const manager = createManager()
      await manager.start()

      await expect(manager.applyPmxPackage({
        files: [
          { path: 'a.pmx', data: new Uint8Array([1]) },
          { path: '../../../outside.png', data: new Uint8Array([2]) },
        ],
        modelId: 'model-2',
        modelPath: 'a.pmx',
        name: 'Model',
      })).rejects.toThrow('unsafe path')

      expect(existsSync(join(state.userData, 'unity-stage', 'models'))).toBe(false)
      expect(received()).toEqual([])
    })

    it('refuses a package whose model is a PMD file, because the sidecar has no loader for it', async () => {
      const manager = createManager()
      await manager.start()

      await expect(manager.applyPmxPackage({
        files: [{ path: 'a.pmd', data: new Uint8Array([1]) }],
        modelId: 'model-2',
        modelPath: 'a.pmd',
        name: 'Model',
      })).rejects.toThrow('Invalid Unity stage PMX package payload.')
    })

    it('writes the idle clip and sends its path', async () => {
      const manager = createManager()
      await manager.start()

      await manager.applyIdle({ id: 'idle', data: new Uint8Array([4]) })

      const path = join(state.userData, 'unity-stage', 'clips', 'idle.vrma')
      expect([...readFileSync(path)]).toEqual([4])
      await vi.waitFor(() => expect(received()).toEqual([{ type: 'host.character.idle', payload: { path } }]))
    })

    it('writes a gesture clip and sends its path and part', async () => {
      const manager = createManager()
      await manager.start()

      await manager.playVrmaGesture({ id: 'dance', part: 'full', data: new Uint8Array([5]) })

      const path = join(state.userData, 'unity-stage', 'clips', 'dance.vrma')
      await vi.waitFor(() => expect(received()).toEqual([{
        type: 'host.character.gesture',
        payload: { kind: 'vrma', id: 'dance', part: 'full', path },
      }]))
    })

    it('refuses files while the stage is not running', async () => {
      const manager = createManager()

      await expect(manager.applyIdle({ id: 'idle', data: new Uint8Array([1]) })).rejects.toThrow('Unity stage is not running.')
      await expect(manager.applyPmxPackage({
        files: [{ path: 'a.pmx', data: new Uint8Array([1]) }],
        modelId: 'a',
        modelPath: 'a.pmx',
        name: 'a',
      })).rejects.toThrow('Unity stage is not running.')
      await expect(manager.playVrmaGesture({ id: 'a', part: 'upper', data: new Uint8Array([1]) })).rejects.toThrow('Unity stage is not running.')
      await expect(manager.applySceneInput({
        data: new Uint8Array([1]),
        fileName: 'model.vrm',
        format: 'vrm',
        modelId: 'a',
        name: 'a',
      })).rejects.toThrow('Unity stage is not running.')
    })
  })

  describe('signals', () => {
    const signals = fixtures.hostMessages.filter(message =>
      message.type === 'host.character.expression'
      || message.type === 'host.character.frame'
      || (message.type === 'host.character.gesture' && message.payload?.kind === 'keys'))

    it('forwards each signal of the protocol fixtures as it is', async () => {
      const manager = createManager()
      await manager.start()

      for (const signal of signals)
        manager.sendSignal(signal)

      await vi.waitFor(() => expect(received()).toHaveLength(signals.length))
      expect(received()).toEqual(signals)
    })

    it('drops an invalid signal and keeps the connection', async () => {
      const manager = createManager()
      await manager.start()

      manager.sendSignal({ type: 'host.character.expression', payload: { name: 'happy', intensity: 5 } })
      manager.sendSignal({ type: 'host.character.expression', payload: { name: 'happy', intensity: 1 } })

      await vi.waitFor(() => expect(received()).toHaveLength(1))
      expect(received()[0].payload?.intensity).toBe(1)
      expect(manager.getStatus().state).toBe('running')
    })

    it('drops a signal while the stage is not running, without an error', () => {
      const manager = createManager()

      expect(() => manager.sendSignal(signals[0])).not.toThrow()
    })
  })

  it('shows a refusal of the renderer in the status', async () => {
    const manager = createManager()
    await manager.start()

    manager.reportError('Unity Stage supports only VRM models.')

    expect(manager.getStatus().lastError).toBe('Unity Stage supports only VRM models.')
    expect(manager.getStatus().state).toBe('running')
  })
})
