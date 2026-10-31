import type { MissionInstance, MustSpeakNotify, NoticeOutcome, ReminderValues } from './missions'

import { describe, expect, it, vi } from 'vitest'

import { collectDueMissions, createReminder, deliverReminder, missedRemindersNoticeText, parseLocalDateTime, reminderNoticeText, settleMissionRun, stopMission } from './missions'

/** Friday 2026-10-30 12:00, local time. */
const NOW = new Date(2026, 9, 30, 12, 0).getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE

function local(year: number, month: number, day: number, hours: number, minutes = 0) {
  return new Date(year, month - 1, day, hours, minutes).getTime()
}

function reminder(values: Partial<ReminderValues> = {}, now = NOW): MissionInstance {
  const result = createReminder({
    id: 'mission-1',
    sessionId: 'session-1',
    values: { text: 'medicine time', at: '2026-10-30T18:00', repeat: { kind: 'once' }, ...values },
    now,
  })
  if (!result.ok)
    throw new Error(result.reason)
  return result.mission
}

describe('parseLocalDateTime', () => {
  it('reads a local date and time', () => {
    expect(parseLocalDateTime('2026-10-31T18:05')).toBe(local(2026, 10, 31, 18, 5))
  })

  it('refuses a date that does not exist', () => {
    expect(parseLocalDateTime('2026-02-30T18:00')).toBeUndefined()
    expect(parseLocalDateTime('2026-10-30T24:00')).toBeUndefined()
  })

  it('refuses other forms', () => {
    expect(parseLocalDateTime('2026-10-30 18:00')).toBeUndefined()
    expect(parseLocalDateTime('2026-10-30T18:00:00Z')).toBeUndefined()
  })
})

describe('createReminder', () => {
  it('schedules a reminder that runs once at its time', () => {
    const mission = reminder()

    expect(mission.status).toBe('scheduled')
    expect(mission.nextRunAt).toBe(local(2026, 10, 30, 18))
  })

  it('accepts a time in the current minute', () => {
    const result = createReminder({ id: 'm', sessionId: 's', values: { text: 'now', at: '2026-10-30T12:00', repeat: { kind: 'once' } }, now: NOW + 30_000 })

    expect(result.ok).toBe(true)
  })

  it('refuses a time in the past', () => {
    const result = createReminder({ id: 'm', sessionId: 's', values: { text: 'late', at: '2026-10-30T11:00', repeat: { kind: 'once' } }, now: NOW })

    expect(result).toEqual({ ok: false, reason: 'The time is in the past. Use a future time.' })
  })

  it('refuses a time more than one year ahead', () => {
    const result = createReminder({ id: 'm', sessionId: 's', values: { text: 'far', at: '2028-01-01T09:00', repeat: { kind: 'once' } }, now: NOW })

    expect(result.ok).toBe(false)
  })

  it('refuses an empty text and a weekly reminder without days', () => {
    expect(createReminder({ id: 'm', sessionId: 's', values: { text: '  ', at: '2026-10-30T18:00', repeat: { kind: 'once' } }, now: NOW }).ok).toBe(false)
    expect(createReminder({ id: 'm', sessionId: 's', values: { text: 'x', at: '2026-10-30T18:00', repeat: { kind: 'weekly', days: [7] } }, now: NOW }).ok).toBe(false)
  })

  it('starts a weekday reminder on Monday when the first date is a Saturday', () => {
    // 2026-10-31 is a Saturday.
    const mission = reminder({ at: '2026-10-31T08:00', repeat: { kind: 'weekdays' } })

    expect(mission.nextRunAt).toBe(local(2026, 11, 2, 8))
  })

  it('starts a repeated reminder on the next day when its first time today has passed', () => {
    const mission = reminder({ at: '2026-10-30T08:00', repeat: { kind: 'daily' } })

    expect(mission.nextRunAt).toBe(local(2026, 10, 31, 8))
  })
})

describe('collectDueMissions', () => {
  it('sorts runs by their lateness', () => {
    const missions = [
      { ...reminder(), id: 'future', nextRunAt: NOW + MINUTE },
      { ...reminder(), id: 'on-time', nextRunAt: NOW - MINUTE },
      { ...reminder(), id: 'missed', nextRunAt: NOW - 3 * HOUR },
      { ...reminder(), id: 'expired', nextRunAt: NOW - 25 * HOUR },
      { ...stopMission(reminder(), NOW), id: 'stopped' },
    ]

    const result = collectDueMissions(missions, NOW)

    expect(result.due.map(mission => mission.id)).toEqual(['on-time'])
    expect(result.missed.map(mission => mission.id)).toEqual(['missed'])
    expect(result.expired.map(mission => mission.id)).toEqual(['expired'])
  })

  it('uses the age limit that the owner set', () => {
    const missions = [{ ...reminder(), nextRunAt: NOW - 3 * HOUR }]

    const result = collectDueMissions(missions, NOW, { missedAgeLimitMs: 2 * HOUR })

    expect(result.expired).toHaveLength(1)
  })
})

describe('settleMissionRun', () => {
  it('ends a reminder that runs once', () => {
    const delivered = settleMissionRun(reminder(), 'delivered', local(2026, 10, 30, 18))
    const expired = settleMissionRun(reminder(), 'expired', local(2026, 11, 2, 9))

    expect(delivered.status).toBe('done')
    expect(delivered.nextRunAt).toBeUndefined()
    expect(expired.status).toBe('missed')
  })

  it('moves a daily reminder to the next day', () => {
    const mission = reminder({ repeat: { kind: 'daily' } })

    const next = settleMissionRun(mission, 'delivered', local(2026, 10, 30, 18))

    expect(next.status).toBe('scheduled')
    expect(next.nextRunAt).toBe(local(2026, 10, 31, 18))
  })

  it('skips the runs that the app missed while it was closed', () => {
    const mission = reminder({ repeat: { kind: 'daily' } })

    const next = settleMissionRun(mission, 'delivered', local(2026, 11, 3, 9))

    expect(next.nextRunAt).toBe(local(2026, 11, 3, 18))
  })

  it('moves a weekly reminder to its next chosen day', () => {
    // Fridays and Mondays. 2026-10-30 is a Friday.
    const mission = reminder({ repeat: { kind: 'weekly', days: [5, 1] } })

    const next = settleMissionRun(mission, 'delivered', local(2026, 10, 30, 18))

    expect(next.nextRunAt).toBe(local(2026, 11, 2, 18))
  })
})

describe('deliverReminder', () => {
  function notifier(...outcomes: NoticeOutcome[]) {
    return vi.fn<MustSpeakNotify>(async () => outcomes.shift() ?? 'failed')
  }

  it('stops after the model speaks', async () => {
    const notify = notifier('spoke')

    await expect(deliverReminder(notify, 'notice', 'Reminder: medicine time')).resolves.toBe('spoke')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('tries the model one more time after an empty reply', async () => {
    const notify = notifier('silent', 'spoke')

    await expect(deliverReminder(notify, 'notice', 'Reminder: medicine time')).resolves.toBe('spoke')
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('speaks the fixed text after two empty replies', async () => {
    const notify = notifier('silent', 'silent', 'spoke')

    await expect(deliverReminder(notify, 'notice', 'Reminder: medicine time')).resolves.toBe('fixed')
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'mission:reminder:fixed', reply: 'Reminder: medicine time' }))
  })

  it('speaks the fixed text at once after a failed model call', async () => {
    const notify = notifier('failed', 'spoke')

    await expect(deliverReminder(notify, 'notice', 'Reminder: medicine time')).resolves.toBe('fixed')
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('reports a reminder that nothing could speak', async () => {
    const notify = notifier('failed', 'failed')

    await expect(deliverReminder(notify, 'notice', 'Reminder: medicine time')).resolves.toBe('unspoken')
  })
})

describe('notice text', () => {
  it('names the reminder and its time', () => {
    expect(reminderNoticeText(reminder())).toBe('Reminder that the owner asked for, due [2026-10-30 18:00]: medicine time')
  })

  it('lists missed reminders in one notice, oldest first', () => {
    const missions = [
      { ...reminder({ text: 'second' }), nextRunAt: local(2026, 10, 30, 9) },
      { ...reminder({ text: 'first' }), nextRunAt: local(2026, 10, 30, 8) },
    ]

    expect(missedRemindersNoticeText(missions)).toBe([
      'The app was closed, so these reminders come late:',
      '- due [2026-10-30 08:00]: first',
      '- due [2026-10-30 09:00]: second',
    ].join('\n'))
  })
})
