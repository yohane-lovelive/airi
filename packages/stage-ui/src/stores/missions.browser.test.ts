import type { ReminderValues } from '@proj-airi/core-agent'

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

function inOneHour(): ReminderValues['at'] {
  const date = new Date(Date.now() + 60 * 60_000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

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
    const result = await first.addReminder({ text: 'medicine time', at: inOneHour(), repeat: { kind: 'once' } }, 'session-1')

    const second = createStore()
    await second.ready()

    expect(result.ok).toBe(true)
    expect(second.active.map(mission => mission.values.text)).toEqual(['medicine time'])
  })

  // A stop from Settings and a run on the leader can overlap. The run must not start the stopped reminder again.
  it('keeps a stopped reminder stopped when a run settles after the stop', async () => {
    const missions = createStore()
    const result = await missions.addReminder({ text: 'stretch', at: inOneHour(), repeat: { kind: 'daily' } }, 'session-1')
    if (!result.ok)
      throw new Error(result.reason)

    await missions.stop(result.mission.id)
    await missions.settle(result.mission.id, 'delivered', Date.now())

    expect(missions.missions[0]?.status).toBe('stopped')
    expect(missions.active).toHaveLength(0)
  })

  it('removes ended missions and keeps active ones', async () => {
    const missions = createStore()
    const ended = await missions.addReminder({ text: 'old', at: inOneHour(), repeat: { kind: 'once' } }, 'session-1')
    await missions.addReminder({ text: 'next', at: inOneHour(), repeat: { kind: 'once' } }, 'session-1')
    if (!ended.ok)
      throw new Error(ended.reason)

    await missions.stop(ended.mission.id)
    await missions.removeEnded()

    expect(missions.missions.map(mission => mission.values.text)).toEqual(['next'])
  })
})
