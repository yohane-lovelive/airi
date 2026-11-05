// @vitest-environment jsdom

import { commentaryIntervalFactor } from '@proj-airi/core-agent'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useInitiativeStore } from './initiative'

describe('initiative store', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('paces small talk at 2 minutes and commentary at 45 seconds by default', () => {
    const store = useInitiativeStore()

    expect(store.smallTalkIntervalMinutes).toBe(2)
    expect(store.commentaryIntervalSeconds).toBe(45)
    expect(store.settingsAt(0, { smallTalk: true }).modes?.idle?.boredomIntervalMs).toBe(120_000)
    // Solo talk keeps its own short pace, on both the wait and the rest after a line.
    expect(store.settingsAt(0, { smallTalk: true, solo: true })).toMatchObject({ solo: true, missionRunning: true, modes: { idle: { boredomIntervalMs: 10_000, refractoryMs: 10_000 } } })
    expect(store.settingsAt(0, { solo: true }).solo).toBe(false)
    expect(store.settingsAt(0, { commentaryActivity: 0.5 }).modes?.commentary?.boredomIntervalMs).toBe(45_000 * commentaryIntervalFactor(0.5))
  })

  it('uses the intervals of the owner, and the screen activity still scales commentary', () => {
    const store = useInitiativeStore()
    store.smallTalkIntervalMinutes = 5
    store.commentaryIntervalSeconds = 90

    expect(store.settingsAt(0, { smallTalk: true }).modes?.idle?.boredomIntervalMs).toBe(300_000)
    expect(store.settingsAt(0, { commentaryActivity: 1 }).modes?.commentary?.boredomIntervalMs).toBe(90_000 * commentaryIntervalFactor(1))
  })

  it('keeps a stored interval inside the limits of Settings', () => {
    localStorage.setItem('initiative/small-talk-interval-minutes', '0')
    localStorage.setItem('initiative/commentary-interval-seconds', '9999')
    const store = useInitiativeStore()

    expect(store.settingsAt(0, { smallTalk: true }).modes?.idle?.boredomIntervalMs).toBe(60_000)
    expect(store.settingsAt(0, { commentaryActivity: 0 }).modes?.commentary?.boredomIntervalMs).toBe(300_000 * commentaryIntervalFactor(0))
  })

  it('returns to the defaults on reset', () => {
    const store = useInitiativeStore()
    store.smallTalkIntervalMinutes = 7
    store.commentaryIntervalSeconds = 20

    store.resetState()

    expect(store.smallTalkIntervalMinutes).toBe(2)
    expect(store.commentaryIntervalSeconds).toBe(45)
  })
})
