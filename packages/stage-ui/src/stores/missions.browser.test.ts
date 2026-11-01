import localforage from 'localforage'

import { createPinia, disposePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useMissionsStore } from './missions'

const records = localforage.createInstance({ name: 'airi-missions', storeName: 'missions' })
const stores: ReturnType<typeof createPinia>[] = []

/** Each store stands for one window. */
function createStore() {
  const pinia = createPinia()
  stores.push(pinia)
  return useMissionsStore(pinia)
}

/** A start one hour from now, so the reminder is valid whenever the test runs. */
const IN_ONE_HOUR = { kind: 'after', minutes: 60 } as const

describe('missions store', () => {
  beforeEach(async () => {
    await records.clear()
  })

  afterEach(async () => {
    for (const pinia of stores.splice(0))
      disposePinia(pinia)
    await records.clear()
  })

  it('keeps a new reminder in IndexedDB, so another window reads it', async () => {
    const first = createStore()
    const result = await first.addReminder({ text: 'medicine time', start: IN_ONE_HOUR, repeat: { kind: 'once' } }, 'session-1')

    const second = createStore()
    await second.ready()

    expect(result.ok).toBe(true)
    expect(second.active.map(mission => mission.template === 'reminder' && mission.values.text)).toEqual(['medicine time'])
  })

  // A stop from Settings and a run on the leader can overlap. The run must not start the stopped reminder again.
  it('keeps a stopped reminder stopped when a run settles after the stop', async () => {
    const missions = createStore()
    const result = await missions.addReminder({ text: 'stretch', start: IN_ONE_HOUR, repeat: { kind: 'daily' } }, 'session-1')
    if (!result.ok)
      throw new Error(result.reason)

    await missions.stop(result.mission.id)
    await missions.settle(result.mission.id, 'delivered', Date.now())

    expect(missions.missions[0]?.status).toBe('stopped')
    expect(missions.active).toHaveLength(0)
  })

  it('removes ended missions and keeps active ones', async () => {
    const missions = createStore()
    const ended = await missions.addReminder({ text: 'old', start: IN_ONE_HOUR, repeat: { kind: 'once' } }, 'session-1')
    await missions.addReminder({ text: 'next', start: IN_ONE_HOUR, repeat: { kind: 'once' } }, 'session-1')
    if (!ended.ok)
      throw new Error(ended.reason)

    await missions.stop(ended.mission.id)
    await missions.removeEnded()

    expect(missions.missions.map(mission => mission.template === 'reminder' && mission.values.text)).toEqual(['next'])
  })

  it('runs one small talk at a time, and ends it with its reason', async () => {
    const missions = createStore()
    const started = await missions.addSmallTalk({ minutes: 30 }, 'session-1')
    const second = await missions.addSmallTalk({ minutes: 10 }, 'session-1')

    expect(started.ok).toBe(true)
    expect(second.ok).toBe(false)
    expect(missions.smallTalkAt(Date.now())?.values.minutes).toBe(30)
    expect(missions.active).toHaveLength(1)

    expect(await missions.endForeground('away', 'small-talk')).toBe(true)
    expect(missions.smallTalkAt(Date.now())).toBeUndefined()
    expect(missions.missions[0]).toMatchObject({ status: 'stopped', endReason: 'away' })
    expect(await missions.endForeground('away', 'small-talk')).toBe(false)
  })

  it('keeps commentary beside nothing else in the foreground, and leaves it running when the owner leaves', async () => {
    const missions = createStore()
    const started = await missions.addCommentary({ app: '', minutes: 60 }, 'session-1', 'Game')

    expect(started.ok).toBe(true)
    expect((await missions.addSmallTalk({ minutes: 10 }, 'session-1')).ok).toBe(false)
    expect(missions.commentaryAt(Date.now())?.values.app).toBe('Game')

    expect(await missions.endForeground('away', 'small-talk')).toBe(false)
    expect(await missions.endForeground('target-closed')).toBe(true)
    expect(missions.commentaryAt(Date.now())).toBeUndefined()
    expect(missions.missions.at(-1)).toMatchObject({ status: 'stopped', endReason: 'target-closed' })
  })
})
