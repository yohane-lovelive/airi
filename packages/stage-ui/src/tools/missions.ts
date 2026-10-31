import type { MissionInstance, ReminderRepeat, ReminderValues } from '@proj-airi/core-agent'
import type { Tool } from '@xsai/shared-chat'

import { formatTimePrefix, MISSION_TEMPLATES } from '@proj-airi/core-agent'
import { rawTool } from '@xsai/tool'
import { array, description, integer, maxLength, maxValue, minLength, minValue, number, picklist, pipe, safeParse, strictObject, string, summarize } from 'valibot'
import { toJsonSchema } from 'xsschema'

export const START_MISSION_TOOL_NAME = 'builtIn_startMission'
export const LIST_MISSIONS_TOOL_NAME = 'builtIn_listMissions'
export const STOP_MISSION_TOOL_NAME = 'builtIn_stopMission'

// Strict function calling needs every property in `required`, in nested objects too, so `days` is always present.
const reminderValues = strictObject({
  text: pipe(string(), minLength(1), maxLength(200), description('What to tell the owner, in the owner\'s words, for example "medicine time".')),
  at: pipe(string(), description('The local date and time of the first run, YYYY-MM-DDTHH:mm. Read the current time from the message time.')),
  repeat: strictObject({
    kind: picklist(['once', 'daily', 'weekdays', 'weekly']),
    days: pipe(array(pipe(number(), integer(), minValue(0), maxValue(6))), description('For "weekly" only: the days, 0 is Sunday and 6 is Saturday. Otherwise an empty list.')),
  }),
})
const startParameters = strictObject({
  template: pipe(picklist(MISSION_TEMPLATES.map(template => template.name)), description('The mission template.')),
  values: reminderValues,
})
const listParameters = strictObject({})
const stopParameters = strictObject({ id: pipe(string(), minLength(1), description('The mission id, as the mission list shows it.')) })

/** What the mission tools change. The caller binds them to the owner conversation of the run. */
interface CreateMissionToolsOptions {
  missions: () => readonly MissionInstance[]
  addReminder: (values: ReminderValues) => Promise<{ ok: true, mission: MissionInstance } | { ok: false, reason: string }>
  stop: (id: string) => Promise<boolean>
}

function repeatOf(input: { kind: 'once' | 'daily' | 'weekdays' | 'weekly', days: number[] }): ReminderRepeat {
  return input.kind === 'weekly' ? { kind: 'weekly', days: input.days } : { kind: input.kind }
}

function describeMission(mission: MissionInstance) {
  const repeat = mission.values.repeat.kind === 'weekly' ? `weekly on days ${mission.values.repeat.days.join(', ')}` : mission.values.repeat.kind
  const next = mission.nextRunAt === undefined ? mission.status : `next ${formatTimePrefix(mission.nextRunAt).trim()}`
  return `- ${mission.id}: ${mission.template}, "${mission.values.text}", ${repeat}, ${next}`
}

/**
 * Creates the mission tools for one run in the owner's own conversation.
 * The model can only start and stop missions. Code checks each value, and a refusal tells the model what to change.
 */
export async function createMissionTools(options: CreateMissionToolsOptions): Promise<Tool[]> {
  const templates = MISSION_TEMPLATES.map(template => `- ${template.name}: ${template.description} Values: ${template.values}`).join('\n')
  return [
    rawTool({
      name: START_MISSION_TOOL_NAME,
      description: `Start a mission when the owner asks for one, for example a reminder. Use it only for the owner's own request. Templates:\n${templates}`,
      parameters: await toJsonSchema(startParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(startParameters, rawInput)
        if (!parsed.success)
          return `Mission not started: ${summarize(parsed.issues)}`
        const { text, at, repeat } = parsed.output.values
        const result = await options.addReminder({ text, at, repeat: repeatOf(repeat) })
        if (!result.ok)
          return `Mission not started: ${result.reason}`
        return `Started mission:\n${describeMission(result.mission)}`
      },
    }),
    rawTool({
      name: LIST_MISSIONS_TOOL_NAME,
      description: 'List the active missions with their ids.',
      parameters: await toJsonSchema(listParameters),
      execute: async () => {
        const active = options.missions().filter(mission => mission.status === 'scheduled')
        return active.length ? active.map(describeMission).join('\n') : 'No active missions.'
      },
    }),
    rawTool({
      name: STOP_MISSION_TOOL_NAME,
      description: 'Stop one active mission when the owner asks.',
      parameters: await toJsonSchema(stopParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(stopParameters, rawInput)
        if (!parsed.success)
          return 'Give the id of an active mission.'
        return await options.stop(parsed.output.id) ? `Stopped mission "${parsed.output.id}".` : 'No active mission with that id.'
      },
    }),
  ]
}
