import type { ChildProcess, SpawnOptions } from 'node:child_process'

import type { UnityStageManager } from '.'

import process from 'node:process'

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { median } from 'es-toolkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createUnityStageManager } from '.'

const state = vi.hoisted(() => ({ exitCodes: [] as (number | null)[], userData: '' }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    // The host reports each exit after a stop as `stopped`, with no exit code. So only this wrapper can see a crash at exit.
    spawn: (executable: string, args: string[], options: SpawnOptions): ChildProcess => {
      const child = actual.spawn(executable, args, options)
      child.once('exit', code => state.exitCodes.push(code))
      return child
    },
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: () => state.userData,
    isPackaged: false,
    on: vi.fn(),
    once: vi.fn(),
  },
}))

vi.mock('../../../libs/bootkit/lifecycle', () => ({ onAppBeforeQuit: vi.fn() }))

const SAMPLE_MODEL = resolve(import.meta.dirname, '../../../../../../../packages/stage-ui/src/assets/vrm/models/AvatarSample-A/AvatarSample_A.vrm')
const SAMPLE_MODEL_B = resolve(import.meta.dirname, '../../../../../../../packages/stage-ui/src/assets/vrm/models/AvatarSample-B/AvatarSample_B.vrm')
const IDLE_CLIP = resolve(import.meta.dirname, '../../../../../../../packages/stage-ui-three/src/assets/vrm/animations/idle_loop.vrma')

/** A first model load compiles shaders and decodes textures, so it takes much longer than the protocol. */
const LOAD_TIMEOUT_MS = 90_000

/**
 * Runs the real Unity player, with the real host and a real model. CI has no Unity license, so it has no player.
 *
 * To run it, build the player and give its path:
 *
 *   pnpm -F @proj-airi/stage-tamagotchi-unity build:player
 *   AIRI_UNITY_STAGE_PLAYER=<path>/airi-unity-stage.exe pnpm -F @proj-airi/stage-tamagotchi exec vitest run --project node player.integration
 */
describe.skipIf(!process.env.AIRI_UNITY_STAGE_PLAYER)('the Unity player', () => {
  let manager: UnityStageManager

  function waitForLastError(predicate: (lastError: string | undefined) => boolean) {
    return vi.waitFor(() => expect(predicate(manager.getStatus().lastError)).toBe(true), { interval: 200, timeout: LOAD_TIMEOUT_MS })
  }

  function sceneInput(modelId: string, data: Uint8Array) {
    return { data, fileName: `${modelId}.vrm`, format: 'vrm' as const, modelId, name: modelId }
  }

  beforeEach(() => {
    state.exitCodes.length = 0
    state.userData = mkdtempSync(join(tmpdir(), 'airi-unity-player-'))
    vi.stubEnv('AIRI_UNITY_STAGE_ATTACH', '')
    vi.stubEnv('AIRI_UNITY_STAGE_EXECUTABLE', process.env.AIRI_UNITY_STAGE_PLAYER!)
    manager = createUnityStageManager()
  })

  afterEach(async () => {
    await manager.stop().catch(() => {})
    vi.unstubAllEnvs()
    rmSync(state.userData, { recursive: true, force: true })

    // Each test starts one player and ends with a stop. A crash at exit gives 3221225477 (0xC0000005) here.
    expect(state.exitCodes).toEqual([0])
  })

  it('starts, reports ready, and exits when the host stops it', async () => {
    const status = await manager.start()

    expect(status.state).toBe('running')
    expect(status.lastError).toBeUndefined()
    const pid = status.pid!

    await manager.stop()

    expect(() => process.kill(pid, 0)).toThrow()
  }, LOAD_TIMEOUT_MS)

  it('reports a broken file, and a later good model clears the error', async () => {
    await manager.start()

    await manager.applySceneInput(sceneInput('broken', new Uint8Array([1, 2, 3])))
    await waitForLastError(lastError => lastError?.includes('Could not load the model broken') ?? false)
    expect(manager.getStatus().state).toBe('running')

    // Only `scene.applied` clears the error. So this also proves that UniVRM loaded the model on Mono.
    await manager.applySceneInput(sceneInput('sample', new Uint8Array(readFileSync(SAMPLE_MODEL))))
    await waitForLastError(lastError => lastError === undefined)
    expect(manager.getStatus().state).toBe('running')
  }, LOAD_TIMEOUT_MS * 2)

  it('keeps its memory flat while models replace each other', async () => {
    const status = await manager.start()
    const models = [SAMPLE_MODEL, SAMPLE_MODEL_B].map(path => new Uint8Array(readFileSync(path)))

    function memoryInMegabytes() {
      const command = `(Get-Process -Id ${status.pid}).WorkingSet64 / 1MB`
      return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).trim())
    }

    /** Only `scene.applied` clears the error of the host, so a cleared mark means that this model replaced the old one. */
    async function loadModels(count: number) {
      for (let index = 0; index < count; index++) {
        const model = index % 2
        manager.reportError('The model is loading.')
        await manager.applySceneInput(sceneInput(`model-${model}`, models[model]))
        await waitForLastError(lastError => lastError === undefined)
      }
    }

    // The Mono heap grows through the first loads and then stops: a measured run gave 614, 700, 703, 707, and 706 MB
    // for each 20 loads. So the first 26 loads do not count.
    await loadModels(26)
    const samples = [memoryInMegabytes()]
    for (let checkpoint = 0; checkpoint < 4; checkpoint++) {
      await loadModels(10)
      samples.push(memoryInMegabytes())
    }

    // The Mono heap also adds blocks of 25 to 80 MB at random times, up to about 100 loads, and a block does not come back.
    // A measured run of 200 loads gave 615, 622, 675, 678, 681, 682, 683, 682, 683, and 682 MB. A leak grows at each
    // checkpoint and a block does not, so the median rise tells them apart. The limit finds a leak of 2 MB for each load.
    const rises = samples.slice(1).map((sample, index) => sample - samples[index])
    expect(median(rises), `samples in MB: ${samples.map(sample => sample.toFixed(0)).join(', ')}`).toBeLessThan(20)
  }, LOAD_TIMEOUT_MS * 8)

  // MMD models have terms of their own, so the repository has none. Give the folder of an unpacked model to run this.
  it.skipIf(!process.env.AIRI_UNITY_STAGE_PMX_SAMPLE)('shows a real PMX package, and replaces it with a VRM model and back', async () => {
    const folder = process.env.AIRI_UNITY_STAGE_PMX_SAMPLE!
    const paths = (readdirSync(folder, { recursive: true }) as string[])
      .filter(path => statSync(join(folder, path)).isFile())
    const modelPath = paths.find(path => /\.pmx$/i.test(path))!
    const pmxPackage = {
      files: paths.map(path => ({ path, data: new Uint8Array(readFileSync(join(folder, path))) })),
      modelId: 'pmx-sample',
      modelPath,
      name: 'PMX sample',
    }
    const rest = { x: 0, y: 0, z: 0 }
    const moveCharacter = () => {
      manager.sendSignal({
        type: 'host.character.frame',
        payload: {
          mouth: { A: 0.5, E: 0, I: 0, O: 0, U: 0 },
          bones: { spine: rest, chest: rest, neck: rest, head: { x: 0.1, y: 0, z: 0 } },
          eyes: { yaw: 0.1, pitch: 0 },
        },
      })
      manager.sendSignal({ type: 'host.character.expression', payload: { name: 'happy', intensity: 1, holdMs: 200 } })
      manager.sendSignal({
        type: 'host.character.gesture',
        payload: {
          kind: 'keys',
          id: 'nod',
          part: 'upper',
          duration: 0.5,
          tracks: [{ bone: 'head', times: [0, 0.5], values: [0, 0, 0, 1, 0.1, 0, 0, 0.995] }],
        },
      })
    }
    await manager.start()
    await manager.applyIdle({ id: 'idle-loop', data: new Uint8Array(readFileSync(IDLE_CLIP)) })

    async function loaded(load: () => Promise<void>) {
      manager.reportError('The model is loading.')
      await load()
      await waitForLastError(lastError => lastError === undefined)
      moveCharacter()
      await new Promise(resolve => setTimeout(resolve, 800))
      expect(manager.getStatus().lastError).toBeUndefined()
    }

    await loaded(() => manager.applyPmxPackage(pmxPackage))
    await loaded(() => manager.applySceneInput(sceneInput('vrm-sample', new Uint8Array(readFileSync(SAMPLE_MODEL)))))
    await loaded(() => manager.applyPmxPackage(pmxPackage))

    expect(manager.getStatus().state).toBe('running')
  }, LOAD_TIMEOUT_MS * 3)

  it('reports a PMX file that is not a model, and stays running', async () => {
    await manager.start()

    await manager.applyPmxPackage({
      files: [{ path: 'broken.pmx', data: new Uint8Array([1, 2, 3]) }],
      modelId: 'broken',
      modelPath: 'broken.pmx',
      name: 'broken',
    })

    await waitForLastError(lastError => lastError?.includes('Could not load the model broken') ?? false)
    expect(manager.getStatus().state).toBe('running')
  }, LOAD_TIMEOUT_MS)

  it('moves a VRM model from each signal, and a broken clip leaves it running', async () => {
    const idle = new Uint8Array(readFileSync(IDLE_CLIP))
    const rest = { x: 0, y: 0, z: 0 }
    const frame = {
      type: 'host.character.frame',
      payload: {
        mouth: { A: 0.5, E: 0, I: 0, O: 0, U: 0 },
        bones: { spine: rest, chest: rest, neck: rest, head: { x: 0.1, y: 0, z: 0 } },
        eyes: { yaw: 0.1, pitch: 0 },
      },
    }
    await manager.start()

    // The host sends the idle before the model, so a signal also comes before a model.
    await manager.applyIdle({ id: 'idle-loop', data: idle })
    manager.sendSignal(frame)
    manager.sendSignal({ type: 'host.character.expression', payload: { name: 'happy', intensity: 1 } })

    manager.reportError('The model is loading.')
    await manager.applySceneInput(sceneInput('sample', new Uint8Array(readFileSync(SAMPLE_MODEL))))
    await waitForLastError(lastError => lastError === undefined)

    manager.sendSignal(frame)
    manager.sendSignal({ type: 'host.character.expression', payload: { name: 'surprised', intensity: 0.5, holdMs: 200 } })
    manager.sendSignal({
      type: 'host.character.gesture',
      payload: {
        kind: 'keys',
        id: 'nod',
        part: 'upper',
        duration: 0.5,
        tracks: [{ bone: 'head', times: [0, 0.5], values: [0, 0, 0, 1, 0.1, 0, 0, 0.995] }],
      },
    })
    await manager.playVrmaGesture({ id: 'upper', part: 'upper', data: idle })
    await manager.playVrmaGesture({ id: 'full', part: 'full', data: idle })
    await manager.playVrmaGesture({ id: 'broken', part: 'upper', data: new Uint8Array([1, 2, 3]) })
    await new Promise(resolve => setTimeout(resolve, 1500))

    expect(manager.getStatus().state).toBe('running')
    expect(manager.getStatus().lastError).toBeUndefined()

    // A later model still loads, so the character path did not break the scene path.
    manager.reportError('The model is loading.')
    await manager.applySceneInput(sceneInput('sample-b', new Uint8Array(readFileSync(SAMPLE_MODEL_B))))
    await waitForLastError(lastError => lastError === undefined)
    expect(manager.getStatus().state).toBe('running')
  }, LOAD_TIMEOUT_MS * 2)
})
