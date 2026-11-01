import type { CommentaryRequest, MissionInstance, ReminderRequest, SmallTalkRequest, WatchRequest } from '@proj-airi/core-agent'

import { createCommentary, createReminder, createSmallTalk, createWatch, formatLocalDateTime } from '@proj-airi/core-agent'
import { describe, expect, it, vi } from 'vitest'

import { createMissionTools, LIST_MISSIONS_TOOL_NAME, START_MISSION_TOOL_NAME, STOP_MISSION_TOOL_NAME } from './missions'

/** A clock start one hour ahead, so the reminder is valid whenever the test runs. */
function inOneHour() {
  return { kind: 'at', at: formatLocalDateTime(Date.now() + 60 * 60_000), minutes: 0 }
}

const NO_REPEAT = { kind: 'once', days: [], minutes: 0 }

async function createHarness() {
  const missions: MissionInstance[] = []
  const addReminder = vi.fn(async (request: ReminderRequest) => {
    const result = createReminder({ id: `mission-${missions.length + 1}`, sessionId: 'session-1', request, now: Date.now() })
    if (result.ok)
      missions.push(result.mission)
    return result
  })
  const addSmallTalk = vi.fn(async (request: SmallTalkRequest) => {
    const result = createSmallTalk({ id: `mission-${missions.length + 1}`, sessionId: 'session-1', request, now: Date.now(), missions })
    if (result.ok)
      missions.push(result.mission)
    return result
  })
  const addCommentary = vi.fn(async (request: CommentaryRequest) => {
    const result = createCommentary({ id: `mission-${missions.length + 1}`, sessionId: 'session-1', request, appInFront: 'Game', now: Date.now(), missions })
    if (result.ok)
      missions.push(result.mission)
    return result
  })
  const addWatch = vi.fn(async (request: WatchRequest) => {
    const result = createWatch({ id: `mission-${missions.length + 1}`, sessionId: 'session-1', request, appInFront: 'Game', now: Date.now(), missions })
    if (result.ok)
      missions.push(result.mission)
    return result
  })
  const stop = vi.fn(async (id: string) => missions.some(mission => mission.id === id))
  const tools = await createMissionTools({ missions: () => missions, addReminder, addSmallTalk, addCommentary, addWatch, stop })
  const run = (name: string, input: unknown) => tools.find(tool => tool.function.name === name)!.execute(input, { messages: [], toolCallId: 'call-1' })
  return { missions, addReminder, addSmallTalk, addCommentary, addWatch, stop, run }
}

describe('mission tools', () => {
  it('starts a weekly reminder with its days', async () => {
    const harness = await createHarness()

    const result = await harness.run(START_MISSION_TOOL_NAME, {
      template: 'reminder',
      values: { text: 'trash day', start: inOneHour(), repeat: { kind: 'weekly', days: [1, 4], minutes: 0 } },
    })

    expect(harness.addReminder).toHaveBeenCalledWith(expect.objectContaining({ repeat: { kind: 'weekly', days: [1, 4] } }))
    expect(result).toContain('Started mission:')
    expect(result).toContain('weekly on days 1, 4')
  })

  it('drops the unused values of the start and the repeat', async () => {
    const harness = await createHarness()

    const start = inOneHour()

    await harness.run(START_MISSION_TOOL_NAME, {
      template: 'reminder',
      values: { text: 'medicine time', start, repeat: { kind: 'daily', days: [], minutes: 0 } },
    })

    expect(harness.addReminder).toHaveBeenCalledWith(expect.objectContaining({ start: { kind: 'at', at: start.at }, repeat: { kind: 'daily' } }))
  })

  it('starts a reminder some minutes from now that repeats each hour', async () => {
    const harness = await createHarness()
    const before = Date.now()

    const result = await harness.run(START_MISSION_TOOL_NAME, {
      template: 'reminder',
      values: { text: 'drink water', start: { kind: 'after', at: '', minutes: 10 }, repeat: { kind: 'interval', days: [], minutes: 60 } },
    })

    expect(harness.addReminder).toHaveBeenCalledWith({ text: 'drink water', start: { kind: 'after', minutes: 10 }, repeat: { kind: 'interval', minutes: 60 } })
    expect(result).toContain('every 60 minutes')
    expect(harness.missions[0]!.nextRunAt).toBeGreaterThanOrEqual(before + 10 * 60_000)
  })

  it('returns the reason when the code refuses the values', async () => {
    const harness = await createHarness()

    const result = await harness.run(START_MISSION_TOOL_NAME, {
      template: 'reminder',
      values: { text: 'too late', start: { kind: 'at', at: '2020-01-01T09:00', minutes: 0 }, repeat: NO_REPEAT },
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
    await harness.run(START_MISSION_TOOL_NAME, { template: 'reminder', values: { text: 'stretch', start: inOneHour(), repeat: NO_REPEAT } })

    const list = await harness.run(LIST_MISSIONS_TOOL_NAME, {})
    const stopped = await harness.run(STOP_MISSION_TOOL_NAME, { id: 'mission-1' })
    const unknown = await harness.run(STOP_MISSION_TOOL_NAME, { id: 'mission-9' })

    expect(list).toContain('- mission-1: reminder, "stretch", once, next [')
    expect(stopped).toBe('Stopped mission "mission-1".')
    expect(unknown).toBe('No active mission with that id.')
  })

  it('starts small talk, lists it with its end time, and refuses values of another template', async () => {
    const harness = await createHarness()

    const started = await harness.run(START_MISSION_TOOL_NAME, { template: 'small-talk', values: { minutes: 30 } })
    expect(harness.addSmallTalk).toHaveBeenCalledWith({ minutes: 30 })
    expect(started).toContain('mission-1: small-talk, until')
    expect(await harness.run(LIST_MISSIONS_TOOL_NAME, {})).toContain('small-talk')

    const mismatch = await harness.run(START_MISSION_TOOL_NAME, { template: 'reminder', values: { minutes: 30 } })
    expect(mismatch).toContain('do not match the template')
    const refused = await harness.run(START_MISSION_TOOL_NAME, { template: 'small-talk', values: { minutes: 500 } })
    expect(refused).toContain('Mission not started: Small talk needs')
  })

  it('starts commentary on the app in front, and refuses commentary values for small talk', async () => {
    const harness = await createHarness()

    const started = await harness.run(START_MISSION_TOOL_NAME, { template: 'commentary', values: { app: '', minutes: 60 } })
    expect(harness.addCommentary).toHaveBeenCalledWith({ app: '', minutes: 60 })
    expect(started).toContain('commentary on Game')
    expect(await harness.run(START_MISSION_TOOL_NAME, { template: 'small-talk', values: { app: 'Game', minutes: 30 } })).toContain('do not match the template')
  })

  it('offers every value shape in the parameter schema', async () => {
    const harness = await createHarness()
    const tools = await createMissionTools({ missions: () => harness.missions, addReminder: harness.addReminder, addSmallTalk: harness.addSmallTalk, addCommentary: harness.addCommentary, addWatch: harness.addWatch, stop: harness.stop })
    const parameters = tools.find(tool => tool.function.name === START_MISSION_TOOL_NAME)!.function.parameters

    expect(parameters).toMatchObject({ properties: { values: { anyOf: [
      expect.objectContaining({ required: ['text', 'start', 'repeat'] }),
      expect.objectContaining({ required: ['minutes'] }),
      expect.objectContaining({ required: ['app', 'minutes'] }),
      expect.objectContaining({ required: ['condition', 'app', 'region', 'minutes'] }),
    ] } } })
  })

  it('starts a watch of a region in the app in front', async () => {
    const harness = await createHarness()

    const started = await harness.run(START_MISSION_TOOL_NAME, { template: 'watch', values: { condition: 'HP is below half', app: '', region: 'top-right', minutes: 60 } })

    expect(harness.addWatch).toHaveBeenCalledWith({ condition: 'HP is below half', app: '', region: 'top-right', minutes: 60 })
    expect(started).toContain('watch "HP is below half" in Game (top-right)')
    expect(await harness.run(START_MISSION_TOOL_NAME, { template: 'watch', values: { condition: 'x', app: '', region: 'middle', minutes: 60 } })).toContain('Mission not started')
  })
})
