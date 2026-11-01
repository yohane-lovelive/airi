import type { CommentaryRequest, MissionInstance, ReminderRepeat, ReminderRequest, ReminderStart, SmallTalkRequest } from '@proj-airi/core-agent'
import type { Tool } from '@xsai/shared-chat'

import { COMMENTARY_MISSION_LIMITS, formatTimePrefix, isMissionActive, MISSION_TEMPLATES, SMALL_TALK_LIMITS } from '@proj-airi/core-agent'
import { rawTool } from '@xsai/tool'
import { array, description, integer, maxLength, maxValue, minLength, minValue, number, picklist, pipe, safeParse, strictObject, string, summarize, union } from 'valibot'
import { toJsonSchema } from 'xsschema'

export const START_MISSION_TOOL_NAME = 'builtIn_startMission'
export const LIST_MISSIONS_TOOL_NAME = 'builtIn_listMissions'
export const STOP_MISSION_TOOL_NAME = 'builtIn_stopMission'

// Strict function calling needs every property in `required`, in nested objects too. So `at`, `days`, and both
// `minutes` are always present, and the kind tells which of them count.
const reminderValues = strictObject({
  text: pipe(string(), minLength(1), maxLength(200), description('What to tell the owner, in the owner\'s words, for example "medicine time".')),
  start: strictObject({
    kind: pipe(picklist(['after', 'at']), description('"after" for any time from now, for example "in 1 minute" or "in 2 hours". "at" only for a clock time that the owner names, for example "at 18:00".')),
    at: pipe(string(), description('For "at" only: the local date and time that the owner named, YYYY-MM-DDTHH:mm. Otherwise an empty string.')),
    minutes: pipe(number(), integer(), minValue(0), description('For "after" only: the minutes from now, for example 120 for "in 2 hours". Code counts them from the real time to the second. Otherwise 0.')),
  }),
  repeat: strictObject({
    kind: picklist(['once', 'daily', 'weekdays', 'weekly', 'interval']),
    days: pipe(array(pipe(number(), integer(), minValue(0), maxValue(6))), description('For "weekly" only: the days, 0 is Sunday and 6 is Saturday. Otherwise an empty list.')),
    minutes: pipe(number(), integer(), minValue(0), description('For "interval" only: the minutes between runs, 15 to 1440. For example 60 for "every hour". Otherwise 0.')),
  }),
})
const smallTalkValues = strictObject({
  minutes: pipe(number(), integer(), description(`How long the small talk runs, ${SMALL_TALK_LIMITS.minMinutes} to ${SMALL_TALK_LIMITS.maxMinutes} minutes. ${SMALL_TALK_LIMITS.defaultMinutes} when the owner names no time.`)),
})
const commentaryValues = strictObject({
  app: pipe(string(), maxLength(120), description('The app of the window to watch, as the owner names it. An empty string for the app in front.')),
  minutes: pipe(number(), integer(), description(`The longest time of the commentary, ${COMMENTARY_MISSION_LIMITS.minMinutes} to ${COMMENTARY_MISSION_LIMITS.maxMinutes} minutes. ${COMMENTARY_MISSION_LIMITS.defaultMinutes} when the owner names no time.`)),
})
const startParameters = strictObject({
  template: pipe(picklist(MISSION_TEMPLATES.map(template => template.name)), description('The mission template.')),
  values: pipe(union([reminderValues, smallTalkValues, commentaryValues]), description('The values of the template: the reminder, small-talk, or commentary values.')),
})

/** The template whose values have this shape. */
function templateOfValues(values: object) {
  if ('text' in values)
    return 'reminder'
  return 'app' in values ? 'commentary' : 'small-talk'
}
const listParameters = strictObject({})
const stopParameters = strictObject({ id: pipe(string(), minLength(1), description('The mission id, as the mission list shows it.')) })

/** What the mission tools change. The caller binds them to the owner conversation of the run. */
interface CreateMissionToolsOptions {
  missions: () => readonly MissionInstance[]
  addReminder: (request: ReminderRequest) => Promise<{ ok: true, mission: MissionInstance } | { ok: false, reason: string }>
  addSmallTalk: (request: SmallTalkRequest) => Promise<{ ok: true, mission: MissionInstance } | { ok: false, reason: string }>
  addCommentary: (request: CommentaryRequest) => Promise<{ ok: true, mission: MissionInstance } | { ok: false, reason: string }>
  stop: (id: string) => Promise<boolean>
}

function startOf(input: { kind: 'after' | 'at', at: string, minutes: number }): ReminderStart {
  return input.kind === 'after' ? { kind: 'after', minutes: input.minutes } : { kind: 'at', at: input.at }
}

function repeatOf(input: { kind: 'once' | 'daily' | 'weekdays' | 'weekly' | 'interval', days: number[], minutes: number }): ReminderRepeat {
  switch (input.kind) {
    case 'weekly':
      return { kind: 'weekly', days: input.days }
    case 'interval':
      return { kind: 'interval', minutes: input.minutes }
    default:
      return { kind: input.kind }
  }
}

function describeRepeat(repeat: ReminderRepeat) {
  switch (repeat.kind) {
    case 'weekly':
      return `weekly on days ${repeat.days.join(', ')}`
    case 'interval':
      return `every ${repeat.minutes} minutes`
    default:
      return repeat.kind
  }
}

function describeMission(mission: MissionInstance) {
  if (mission.template === 'small-talk')
    return `- ${mission.id}: small-talk, until ${formatTimePrefix(mission.values.endsAt).trim()}`
  if (mission.template === 'commentary')
    return `- ${mission.id}: commentary on ${mission.values.app}, until ${formatTimePrefix(mission.values.endsAt).trim()} or until the window closes`
  const repeat = describeRepeat(mission.values.repeat)
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
      description: `Start a mission when the owner asks for one, for example a reminder, small talk, or commentary. Use it only for the owner's own request. Templates:\n${templates}`,
      parameters: await toJsonSchema(startParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(startParameters, rawInput)
        if (!parsed.success)
          return `Mission not started: ${summarize(parsed.issues)}`
        const { template, values } = parsed.output
        if (templateOfValues(values) !== template)
          return `Mission not started: the values do not match the template "${template}".`
        const result = 'text' in values
          ? await options.addReminder({ text: values.text, start: startOf(values.start), repeat: repeatOf(values.repeat) })
          : 'app' in values
            ? await options.addCommentary({ app: values.app, minutes: values.minutes })
            : await options.addSmallTalk({ minutes: values.minutes })
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
        const active = options.missions().filter(isMissionActive)
        return active.length ? active.map(describeMission).join('\n') : 'No active missions.'
      },
    }),
    rawTool({
      name: STOP_MISSION_TOOL_NAME,
      description: 'Stop one active mission when the owner asks, for example when the owner wants small talk to end.',
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
