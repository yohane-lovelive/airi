import type { MissionInstance, ReminderValues } from '@proj-airi/core-agent'

import { createReminder } from '@proj-airi/core-agent'
import { describe, expect, it, vi } from 'vitest'

import { createMissionTools, LIST_MISSIONS_TOOL_NAME, START_MISSION_TOOL_NAME, STOP_MISSION_TOOL_NAME } from './missions'

/** A future local time, so the reminder is valid whenever the test runs. */
function inOneHour() {
  const date = new Date(Date.now() + 60 * 60_000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function createHarness() {
  const missions: MissionInstance[] = []
  const addReminder = vi.fn(async (values: ReminderValues) => {
    const result = createReminder({ id: `mission-${missions.length + 1}`, sessionId: 'session-1', values, now: Date.now() })
    if (result.ok)
      missions.push(result.mission)
    return result
  })
  const stop = vi.fn(async (id: string) => missions.some(mission => mission.id === id))
  const tools = await createMissionTools({ missions: () => missions, addReminder, stop })
  const run = (name: string, input: unknown) => tools.find(tool => tool.function.name === name)!.execute(input, { messages: [], toolCallId: 'call-1' })
  return { addReminder, stop, run }
}

describe('mission tools', () => {
  it('starts a weekly reminder with its days', async () => {
    const harness = await createHarness()

    const result = await harness.run(START_MISSION_TOOL_NAME, {
      template: 'reminder',
      values: { text: 'trash day', at: inOneHour(), repeat: { kind: 'weekly', days: [1, 4] } },
    })

    expect(harness.addReminder).toHaveBeenCalledWith(expect.objectContaining({ repeat: { kind: 'weekly', days: [1, 4] } }))
    expect(result).toContain('Started mission:')
    expect(result).toContain('weekly on days 1, 4')
  })

  it('drops the days of a reminder that does not repeat weekly', async () => {
    const harness = await createHarness()

    await harness.run(START_MISSION_TOOL_NAME, {
      template: 'reminder',
      values: { text: 'medicine time', at: inOneHour(), repeat: { kind: 'daily', days: [] } },
    })

    expect(harness.addReminder).toHaveBeenCalledWith(expect.objectContaining({ repeat: { kind: 'daily' } }))
  })

  it('returns the reason when the code refuses the values', async () => {
    const harness = await createHarness()

    const result = await harness.run(START_MISSION_TOOL_NAME, {
      template: 'reminder',
      values: { text: 'too late', at: '2020-01-01T09:00', repeat: { kind: 'once', days: [] } },
    })

    expect(result).toBe('Mission not started: The time is in the past. Use a future time.')
  })

  it('refuses an input without the required values', async () => {
    const harness = await createHarness()

    const result = await harness.run(START_MISSION_TOOL_NAME, { template: 'reminder', values: { text: 'x' } })

    expect(result).toMatch(/^Mission not started: /)
    expect(harness.addReminder).not.toHaveBeenCalled()
  })

  it('lists the active missions and stops one by its id', async () => {
    const harness = await createHarness()
    await harness.run(START_MISSION_TOOL_NAME, { template: 'reminder', values: { text: 'stretch', at: inOneHour(), repeat: { kind: 'once', days: [] } } })

    const list = await harness.run(LIST_MISSIONS_TOOL_NAME, {})
    const stopped = await harness.run(STOP_MISSION_TOOL_NAME, { id: 'mission-1' })
    const unknown = await harness.run(STOP_MISSION_TOOL_NAME, { id: 'mission-9' })

    expect(list).toContain('- mission-1: reminder, "stretch", once, next [')
    expect(stopped).toBe('Stopped mission "mission-1".')
    expect(unknown).toBe('No active mission with that id.')
  })
})
