import type { UnityStageManager } from '.'

import process from 'node:process'

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createUnityStageManager } from '.'

const state = vi.hoisted(() => ({ userData: '' }))

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
    state.userData = mkdtempSync(join(tmpdir(), 'airi-unity-player-'))
    vi.stubEnv('AIRI_UNITY_STAGE_ATTACH', '')
    vi.stubEnv('AIRI_UNITY_STAGE_EXECUTABLE', process.env.AIRI_UNITY_STAGE_PLAYER!)
    manager = createUnityStageManager()
  })

  afterEach(async () => {
    await manager.stop().catch(() => {})
    vi.unstubAllEnvs()
    rmSync(state.userData, { recursive: true, force: true })
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
    const settled = memoryInMegabytes()

    await loadModels(40)
    const after = memoryInMegabytes()

    // A leak of one set of 4K textures for each load is far more than this limit.
    expect(after - settled, `${settled.toFixed(0)} MB after 26 loads, ${after.toFixed(0)} MB after 66 loads`).toBeLessThan(60)
  }, LOAD_TIMEOUT_MS * 8)

  it('accepts each signal without an error, because step U3 applies them later', async () => {
    await manager.start()
    const rest = { x: 0, y: 0, z: 0 }

    manager.sendSignal({ type: 'host.character.expression', payload: { name: 'happy', intensity: 1 } })
    manager.sendSignal({
      type: 'host.character.frame',
      payload: {
        mouth: { A: 0.5, E: 0, I: 0, O: 0, U: 0 },
        bones: { spine: rest, chest: rest, neck: rest, head: rest },
        eyes: { yaw: 0, pitch: 0 },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 500))

    expect(manager.getStatus().state).toBe('running')
    expect(manager.getStatus().lastError).toBeUndefined()
  }, LOAD_TIMEOUT_MS)
})
