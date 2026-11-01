import { TIMELINE_LIMITS } from '@proj-airi/core-agent'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { timelineRepo } from '../database/repos/timeline.repo'
import { useTimelineStore } from './timeline'

const { generate } = vi.hoisted(() => ({ generate: vi.fn(async () => 'Played two matches.') }))

vi.mock('./chat/session-store', () => ({
  useChatSessionStore: () => ({ sessionMetas: { 'session-1': { characterId: 'airi' } } }),
}))
vi.mock('./modules/airi-card', () => ({
  useAiriCardStore: () => ({ getModules: () => ({ consciousness: { provider: 'provider', model: 'model' } }) }),
}))
vi.mock('../composables/text-generation', () => ({
  useTextGeneration: () => ({ generateText: () => generate }),
}))

/** A fresh store, like a window that opens after the change. */
function createStore() {
  setActivePinia(createPinia())
  return useTimelineStore()
}

describe('useTimelineStore', () => {
  beforeEach(async () => {
    await timelineRepo.clear()
    generate.mockClear()
  })

  it('keeps notes and the scene on the device, so another window reads them', async () => {
    const first = createStore()
    const now = Date.now()
    await first.addNotes('session-1', [{ at: now, text: 'the match started', source: 'model' }])
    await first.setScene('session-1', 'ranked match', now + 1)

    const second = createStore()
    expect(second.timelineOf('session-1')).toEqual({ notes: [] })
    expect(await second.load('session-1')).toEqual({ notes: [{ at: now, text: 'the match started', source: 'model' }], scene: { text: 'ranked match', at: now + 1 } })
    expect(generate).not.toHaveBeenCalled()
  })

  it('keeps each conversation apart, and deletes one timeline', async () => {
    const timelines = createStore()
    await timelines.addNotes('session-1', [{ at: Date.now(), text: 'one', source: 'code' }])
    await timelines.addNotes('session-2', [{ at: Date.now(), text: 'two', source: 'code' }])

    await timelines.clear('session-1')

    expect(await timelines.load('session-1')).toEqual({ notes: [] })
    expect((await timelines.load('session-2')).notes.map(note => note.text)).toEqual(['two'])
  })

  it('summarizes the oldest notes when the timeline grows past its limit', async () => {
    const timelines = createStore()
    const now = Date.now()
    const notes = Array.from({ length: TIMELINE_LIMITS.maxNotes + 1 }, (_, index) => ({ at: now - 60_000 + index, text: `note ${index}`, source: 'model' as const }))

    await timelines.addNotes('session-1', notes)

    await expect.poll(() => timelines.timelineOf('session-1').summary?.text).toBe('Played two matches.')
    expect(generate).toHaveBeenCalledTimes(1)
    expect(timelines.timelineOf('session-1').notes).toHaveLength(TIMELINE_LIMITS.maxNotes + 1 - TIMELINE_LIMITS.summarizeCount)
  })
})
