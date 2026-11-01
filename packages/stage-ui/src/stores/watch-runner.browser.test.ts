import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import type { CapturedFrame } from '../libs/perception/frame-ring'

import { createPinia, setActivePinia } from 'pinia'
import { createSyncedPiniaPlugin } from 'pinia-plugin-synced'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { missionsRepo } from '../database/repos/missions.repo'
import { encodeFrame } from '../libs/perception/encode-frame'
import { useMissionsStore } from './missions'
import { usePerceptionStore } from './perception'
import { useWatchRunnerStore } from './watch-runner'

const state = vi.hoisted(() => ({
  frames: [] as CapturedFrame[],
  app: 'Game' as string | undefined,
  answer: { holds: false, seen: 'HP is full' },
  notify: vi.fn(async (_sessionId: string, _notice: { source: string, text: string, mustSpeak?: boolean }) => 'spoke' as const),
  generate: vi.fn(),
  notes: vi.fn(async () => {}),
}))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('./chat', () => ({ useChatStore: () => ({ notifyConversation: state.notify }) }))
vi.mock('./chat/session-store', () => ({ useChatSessionStore: () => ({ sessionMetas: { 'session-1': { characterId: 'airi' } }, activeSessionId: 'session-1' }) }))
vi.mock('./modules/airi-card', () => ({ useAiriCardStore: () => ({ activeCardId: 'airi', getModules: () => ({ consciousness: { provider: 'provider', model: 'model' } }) }) }))
vi.mock('./timeline', () => ({ useTimelineStore: () => ({ addNotes: state.notes }) }))
vi.mock('./perception-runner', () => ({
  usePerceptionRunnerStore: () => ({ running: () => true, excludedNow: () => false, foregroundApp: () => state.app, frames: () => state.frames }),
}))
vi.mock('../composables/text-generation', () => ({
  useTextGeneration: () => ({
    // The model answers with the tool at once, like a real check turn.
    generateText: () => async (conversation: unknown, _signal: AbortSignal, tools: Array<{ execute: (input: unknown, options: unknown) => Promise<unknown> }>) => {
      state.generate(conversation)
      await tools[0].execute(state.answer, { messages: [], toolCallId: 'call-1' })
      return ''
    },
  }),
}))

let runtime: SyncedPiniaRuntime | undefined

async function frame(color: string): Promise<CapturedFrame> {
  const canvas = new OffscreenCanvas(640, 360)
  const context = canvas.getContext('2d')!
  context.fillStyle = color
  context.fillRect(0, 0, 640, 360)
  return encodeFrame(await createImageBitmap(canvas), Date.now())
}

describe('useWatchRunnerStore', () => {
  beforeEach(async () => {
    localStorage.clear()
    await missionsRepo.clear()
    const pinia = createPinia()
    runtime = createSyncedPiniaPlugin({ callTimeout: 1000, leadership: 'leader-only', namespace: `watch:${crypto.randomUUID()}` })
    pinia.use(runtime.plugin)
    createApp({}).use(pinia)
    setActivePinia(pinia)
    await vi.waitFor(() => expect(runtime?.isLeader()).toBe(true))
    state.notify.mockClear()
    state.generate.mockClear()
    state.notes.mockClear()
    state.app = 'Game'
    state.answer = { holds: false, seen: 'HP is full' }
    state.frames = [await frame('#202020')]
  })

  afterEach(() => {
    runtime?.dispose()
  })

  async function start() {
    const missions = useMissionsStore()
    missions.enabled = true
    const perception = usePerceptionStore()
    const result = await missions.addWatch({ condition: 'HP is below half', app: '', region: 'top-right', minutes: 60 }, 'session-1', 'Game')
    if (!result.ok)
      throw new Error(result.reason)
    useWatchRunnerStore().initialize(runtime!)
    return { missions, perception, id: result.mission.id }
  }

  it('checks a crop of the region at once, records what it saw, and counts one image', async () => {
    const { missions, perception, id } = await start()

    await expect.poll(() => missions.missions.find(mission => mission.id === id)?.template === 'watch' && missions.watchAt(Date.now())?.values.lastSeen, { timeout: 10_000 }).toBe('HP is full')
    expect(state.generate).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(state.generate.mock.calls[0][0])).toContain('data:image/jpeg;base64,')
    expect(perception.budgetAt(Date.now()).used).toBe(1)
    expect(state.notify).not.toHaveBeenCalled()
  })

  it('tells the owner once with a mustSpeak notice when the condition holds, and ends as done', async () => {
    state.answer = { holds: true, seen: 'HP bar is red' }
    const { missions, id } = await start()

    await expect.poll(() => missions.missions.find(mission => mission.id === id)?.status, { timeout: 10_000 }).toBe('done')
    expect(state.notify).toHaveBeenCalledWith('session-1', expect.objectContaining({ source: 'mission:watch', mustSpeak: true, text: expect.stringContaining('HP bar is red') }))
    expect(missions.missions.find(mission => mission.id === id)).toMatchObject({ endReason: 'condition' })
    expect(state.notes).toHaveBeenCalledWith('session-1', [expect.objectContaining({ text: 'Watch held: HP is below half' })])
  })

  it('waits while another app is in front, and while the image budget is empty', async () => {
    state.app = 'Editor'
    const { perception } = await start()
    await new Promise(resolve => setTimeout(resolve, 2_500))
    expect(state.generate).not.toHaveBeenCalled()

    state.app = 'Game'
    perception.imagesPerHour = 0
    await new Promise(resolve => setTimeout(resolve, 2_500))
    expect(state.generate).not.toHaveBeenCalled()
  })
})
