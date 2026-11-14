import type { ChildProcess, SpawnOptions } from 'node:child_process'

import type { StageViewSnapshotPayload } from '@proj-airi/stage-shared/godot-stage'

import type { GodotStageManager } from '.'
import type { ElectronGodotStageStatus } from '../../../../shared/eventa'

import process from 'node:process'

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createGodotStageManager } from '.'

const FAKE_SIDECAR = resolve(import.meta.dirname, '../../../../../scripts/fake-stage-sidecar.mjs')

const state = vi.hoisted(() => ({
  spawned: [] as { executable: string, args: string[], cwd?: string }[],
  userData: '',
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => state.userData,
    isPackaged: false,
    on: vi.fn(),
    once: vi.fn(),
  },
}))

vi.mock('../../../libs/bootkit/lifecycle', () => ({ onAppBeforeQuit: vi.fn() }))

vi.mock('../../../libs/electron/location', () => ({ getElectronMainDirname: () => import.meta.dirname }))

// The process boundary stays real. Only the executable changes, because no Godot exists on a test machine.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (executable: string, args: string[], options: SpawnOptions): ChildProcess => {
      state.spawned.push({ executable, args, cwd: options.cwd?.toString() })
      return actual.spawn(process.execPath, [FAKE_SIDECAR, ...args], { ...options, cwd: undefined })
    },
  }
})

describe('createGodotStageManager', () => {
  let managers: GodotStageManager[] = []
  let logPath = ''

  function createManager() {
    const manager = createGodotStageManager()
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
    state.spawned.length = 0
    state.userData = mkdtempSync(join(tmpdir(), 'airi-godot-stage-'))
    logPath = join(state.userData, 'received.jsonl')
    vi.stubEnv('GODOT4', process.execPath)
    vi.stubEnv('FAKE_SIDECAR_LOG', logPath)
    vi.stubEnv('FAKE_SIDECAR_MODE', 'normal')
  })

  afterEach(async () => {
    await Promise.all(managers.map(manager => manager.stop().catch(() => {})))
    managers = []
    vi.unstubAllEnvs()
    rmSync(state.userData, { recursive: true, force: true })
  })

  it('starts the engine against the project, and runs after the sidecar reports ready', async () => {
    const manager = createManager()

    const status = await manager.start()

    expect(status.state).toBe('running')
    expect(status.pid).toBeTypeOf('number')
    expect(state.spawned).toHaveLength(1)
    expect(state.spawned[0].executable).toBe(process.execPath)
    expect(state.spawned[0].args[0]).toBe('--path')
    expect(state.spawned[0].args[1]).toMatch(/stage-tamagotchi-godot$/)
    expect(state.spawned[0].args[2]).toBe('--')
    expect(state.spawned[0].args[3]).toMatch(/^--airi-ws-url=ws:\/\/127\.0\.0\.1:\d+\/ws\?token=/)
    expect(state.spawned[0].args[4]).toBe(`--airi-storage-root=${join(state.userData, 'godot-stage')}`)
    expect(state.spawned[0].cwd).toBe(state.spawned[0].args[1])
  })

  it('keeps one process when start runs twice', async () => {
    const manager = createManager()

    await manager.start()
    const status = await manager.start()

    expect(status.state).toBe('running')
    expect(state.spawned).toHaveLength(1)
  })

  it('reports each state of a start and a stop', async () => {
    const manager = createManager()
    const states: ElectronGodotStageStatus['state'][] = []
    manager.subscribe(status => states.push(status.state))

    await manager.start()
    await manager.stop()

    expect(states[0]).toBe('stopped')
    expect(states).toContain('starting')
    expect(states).toContain('running')
    expect(states).toContain('stopping')
    expect(states.at(-1)).toBe('stopped')
  })

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

    const path = join(state.userData, 'godot-stage', 'models', 'model-1', 'model.vrm')
    expect([...readFileSync(path)]).toEqual([1, 2, 3])
    await vi.waitFor(() => expect(received().map(message => message.type)).toContain('host.scene.apply'))
    expect(received()[0].payload).toEqual({ format: 'vrm', modelId: 'model-1', name: 'Model', path })
  })

  it('refuses a model while the stage is not running', async () => {
    const manager = createManager()

    await expect(manager.applySceneInput({
      data: new Uint8Array([1]),
      fileName: 'model.vrm',
      format: 'vrm',
      modelId: 'model-1',
      name: 'Model',
    })).rejects.toThrow('Godot stage is not running.')
  })

  it('keeps a scene error in the status until a later scene applies', async () => {
    const manager = createManager()
    await manager.start()

    await manager.applySceneInput({
      data: new Uint8Array([1]),
      fileName: 'broken.vrm',
      format: 'vrm',
      modelId: 'model-1',
      name: 'Model',
    })
    await vi.waitFor(() => expect(manager.getStatus().lastError).toBe('The file is broken.'))
    expect(manager.getStatus().state).toBe('running')

    await manager.applySceneInput({
      data: new Uint8Array([1]),
      fileName: 'model.vrm',
      format: 'vrm',
      modelId: 'model-1',
      name: 'Model',
    })
    await vi.waitFor(() => expect(manager.getStatus().lastError).toBeUndefined())
  })

  it('forwards view snapshots, and forgets them when the stage stops', async () => {
    const manager = createManager()
    const snapshots: StageViewSnapshotPayload[] = []
    manager.subscribeViewSnapshot(snapshot => snapshots.push(snapshot))
    await manager.start()

    const { requestId } = await manager.requestViewSnapshot()
    await vi.waitFor(() => expect(snapshots).toHaveLength(1))
    expect(snapshots[0].requestId).toBe(requestId)
    expect(snapshots[0].reason).toBe('request')
    expect(manager.getViewSnapshot()).toEqual(snapshots[0])

    await manager.applyViewPatch({ camera: { fovDeg: 30 } })
    await vi.waitFor(() => expect(snapshots).toHaveLength(2))
    expect(snapshots[1].reason).toBe('remote-patch')

    await manager.stop()
    expect(manager.getViewSnapshot()).toBeNull()
  })

  it('rejects an invalid view patch before it reaches the sidecar', async () => {
    const manager = createManager()
    await manager.start()

    await expect(manager.applyViewPatch({ camera: {} })).rejects.toThrow('Invalid Godot stage view-state patch payload.')
    expect(received()).toEqual([])
  })

  it('sends a shutdown when it stops, and the process exits', async () => {
    const manager = createManager()
    await manager.start()

    const status = await manager.stop()

    expect(status.state).toBe('stopped')
    expect(status.pid).toBeNull()
    expect(received().map(message => message.type)).toEqual(['host.shutdown'])
  })

  it('kills a process that ignores the shutdown', async () => {
    vi.stubEnv('FAKE_SIDECAR_MODE', 'ignore-shutdown')
    const manager = createManager()
    await manager.start()

    const status = await manager.stop()

    expect(status.state).toBe('stopped')
    expect(status.lastError).toBeUndefined()
  }, 15_000)

  it('fails the start when the sidecar reports a fatal error', async () => {
    vi.stubEnv('FAKE_SIDECAR_MODE', 'fatal')
    const manager = createManager()

    await expect(manager.start()).rejects.toThrow('The fake sidecar failed by request.')

    expect(manager.getStatus().state).toBe('error')
    expect(manager.getStatus().lastError).toBe('The fake sidecar failed by request.')
  })

  it('fails the start when the process exits before it is ready', async () => {
    vi.stubEnv('FAKE_SIDECAR_MODE', 'crash')
    const manager = createManager()

    await expect(manager.start()).rejects.toThrow('Godot stage exited with code 3.')

    expect(manager.getStatus().state).toBe('error')
  })

  it('reports an unexpected exit of a running process, and can start again', async () => {
    const manager = createManager()
    await manager.start()

    process.kill(manager.getStatus().pid!)
    await vi.waitFor(() => expect(manager.getStatus().state).toBe('error'))
    expect(manager.getStatus().lastError).toMatch(/^Godot stage exited with/)
    expect(manager.getStatus().pid).toBeNull()

    const status = await manager.start()
    expect(status.state).toBe('running')
    expect(state.spawned).toHaveLength(2)
  })

  it('explains a missing GODOT4 variable', async () => {
    vi.stubEnv('GODOT4', '')
    const manager = createManager()

    await expect(manager.start()).rejects.toThrow('GODOT4 is required to start Godot Stage in development mode.')

    expect(manager.getStatus().state).toBe('error')
    expect(state.spawned).toHaveLength(0)
  })
})
