import type { Intention, ReminderMission } from '@proj-airi/core-agent'

import { describe, expect, it } from 'vitest'

import { intentionToFields, reminderToFields, splitAutonomyChanges } from '.'

const REMINDER: ReminderMission = {
  id: 'r1',
  sessionId: 'session-1',
  template: 'reminder',
  status: 'scheduled',
  nextRunAt: 2_000,
  createdAt: 1_000,
  updatedAt: 1_000,
  values: { text: '薬を飲む', at: '2026-11-03T09:00', repeat: { kind: 'weekly', days: [1, 3] } },
}

const INTENTION: Intention = { id: 'i1', text: '旅行の話を聞く', createdAt: 1_000, expiresAt: 90_000 }

const NONE = { reminderIds: new Set<string>(), intentionIds: new Set<string>() }

describe('autonomy record fields', () => {
  it('keeps a reminder and an intention as a kind and a plain JSON record', () => {
    expect(reminderToFields({ ...REMINDER, lastRunAt: undefined })).toEqual({ kind: 'reminder', record: REMINDER })
    expect(intentionToFields(INTENTION)).toEqual({ kind: 'intention', record: INTENTION })
  })
})

describe('splitAutonomyChanges', () => {
  it('takes valid records of each kind, and refuses records that do not fit their kind or their id', () => {
    const split = splitAutonomyChanges({
      upserts: {
        r1: reminderToFields(REMINDER),
        i1: intentionToFields(INTENTION),
        broken: { kind: 'reminder', record: { ...REMINDER, id: 'broken', status: 'paused' } },
        moved: reminderToFields(REMINDER),
        unknown: { kind: 'watch', record: {} },
      },
      removals: [],
      conflictCopies: [],
    }, NONE)

    expect(split.reminders.saved).toEqual([REMINDER])
    expect(split.intentions.saved).toEqual([INTENTION])
    expect(split.rejected).toEqual(['broken', 'moved', 'unknown'])
  })

  it('sends each removal to the kind of its local record, and drops the local side of a lost conflict', () => {
    const split = splitAutonomyChanges({
      upserts: {},
      removals: ['r1', 'i1', 'missing'],
      conflictCopies: [{ documentId: 'r1', fields: reminderToFields(REMINDER) }],
    }, { reminderIds: new Set(['r1']), intentionIds: new Set(['i1']) })

    expect(split).toEqual({ reminders: { saved: [], removed: ['r1'] }, intentions: { saved: [], removed: ['i1'] }, rejected: [] })
  })
})
