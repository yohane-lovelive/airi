import { describe, expect, it } from 'vitest'

import { activeTalkControl, applyTalkLevel, TALK_CONTROL_LIMITS, talkControlEffect } from './talk-control'

const MINUTE_MS = 60_000

describe('applyTalkLevel', () => {
  it('starts a quiet time', () => {
    expect(applyTalkLevel({}, { kind: 'quiet', minutes: 30 }, 1_000)).toEqual({ ok: true, control: { quietUntil: 1_000 + 30 * MINUTE_MS } })
  })

  it('refuses a quiet time without minutes, and minutes outside the limits', () => {
    expect(applyTalkLevel({}, { kind: 'quiet', minutes: 0 }, 0).ok).toBe(false)
    expect(applyTalkLevel({}, { kind: 'quiet', minutes: TALK_CONTROL_LIMITS.maxMinutes + 1 }, 0).ok).toBe(false)
    expect(applyTalkLevel({}, { kind: 'less', minutes: -1 }, 0).ok).toBe(false)
    expect(applyTalkLevel({}, { kind: 'more', minutes: 1.5 }, 0).ok).toBe(false)
  })

  it('changes the interval for a time, and a new change replaces the old one', () => {
    const less = applyTalkLevel({}, { kind: 'less', minutes: 60 }, 0)
    expect(less).toEqual({ ok: true, control: { interval: { factor: TALK_CONTROL_LIMITS.lessFactor, until: 60 * MINUTE_MS } } })

    const more = applyTalkLevel(less.ok ? less.control : {}, { kind: 'more', minutes: 10 }, MINUTE_MS)
    expect(more).toEqual({ ok: true, control: { interval: { factor: TALK_CONTROL_LIMITS.moreFactor, until: 11 * MINUTE_MS } } })
  })

  it('asks for a permanent change with 0 minutes, and drops the temporary interval', () => {
    const control = { quietUntil: 10 * MINUTE_MS, interval: { factor: 2 / 3, until: 10 * MINUTE_MS } }

    expect(applyTalkLevel(control, { kind: 'less', minutes: 0 }, 0)).toEqual({ ok: true, control: { quietUntil: 10 * MINUTE_MS }, permanentFactor: TALK_CONTROL_LIMITS.lessFactor })
  })

  it('ends a quiet time when the owner asks for more talk', () => {
    const control = { quietUntil: 10 * MINUTE_MS }

    expect(applyTalkLevel(control, { kind: 'more', minutes: 0 }, 0)).toEqual({ ok: true, control: {}, permanentFactor: TALK_CONTROL_LIMITS.moreFactor })
    expect(applyTalkLevel(control, { kind: 'less', minutes: 5 }, 0)).toMatchObject({ ok: true, control: { quietUntil: 10 * MINUTE_MS } })
  })

  it('ends every temporary change on normal', () => {
    expect(applyTalkLevel({ quietUntil: 10, interval: { factor: 1.5, until: 10 } }, { kind: 'normal' }, 0)).toEqual({ ok: true, control: {} })
  })
})

describe('talkControlEffect', () => {
  it('reads the active parts, and drops the parts that ended', () => {
    const control = { quietUntil: 100, interval: { factor: 1.5, until: 200 } }

    expect(talkControlEffect(control, 50)).toEqual({ quietUntil: 100, idleIntervalFactor: 1.5 })
    expect(talkControlEffect(control, 150)).toEqual({ idleIntervalFactor: 1.5 })
    expect(talkControlEffect(control, 200)).toEqual({ idleIntervalFactor: 1 })
    expect(activeTalkControl(control, 200)).toEqual({})
  })
})
