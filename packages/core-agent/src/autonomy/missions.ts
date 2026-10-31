import { formatTimePrefix } from '../messages/datetime-prefix'

/**
 * The life of a mission instance.
 *
 * - `scheduled`: it waits for `nextRunAt`. A repeated reminder stays here after each run.
 * - `done`: a reminder that runs once reached the owner.
 * - `stopped`: the owner or the model stopped it.
 * - `missed`: a reminder that runs once came due while the app was closed, longer ago than the age limit.
 */
export type MissionStatus = 'scheduled' | 'done' | 'stopped' | 'missed'

/**
 * How a reminder repeats. Weekly days use `Date.getDay()` numbers: 0 is Sunday and 6 is Saturday.
 * An `interval` reminder runs each `minutes` after its first run.
 */
export type ReminderRepeat
  = | { readonly kind: 'once' }
    | { readonly kind: 'daily' }
    | { readonly kind: 'weekdays' }
    | { readonly kind: 'weekly', readonly days: readonly number[] }
    | { readonly kind: 'interval', readonly minutes: number }

/**
 * When the first run of a new reminder is.
 * - `at`: a local clock time, `YYYY-MM-DDTHH:mm`.
 * - `after`: minutes from the moment that code creates the reminder. The model does not count the time itself, so a
 *   request such as "in one minute" never lands in the past.
 */
export type ReminderStart
  = | { readonly kind: 'at', readonly at: string }
    | { readonly kind: 'after', readonly minutes: number }

/** A new reminder, as the model asks for it. */
export interface ReminderRequest {
  readonly text: string
  readonly start: ReminderStart
  readonly repeat: ReminderRepeat
}

/** The stored values of a `reminder` instance. */
export interface ReminderValues {
  /** What the character tells the owner, in the owner's words. The fallback speech reads it as it is. */
  readonly text: string
  /**
   * The local date and time of the first run, `YYYY-MM-DDTHH:mm`, without seconds. A daily, weekday, or weekly reminder
   * runs at this time of day. An interval reminder counts its runs from its exact first run.
   */
  readonly at: string
  readonly repeat: ReminderRepeat
}

/** One mission that the model created from the owner's words. Step 1 has the `reminder` template only. */
export interface MissionInstance {
  readonly id: string
  readonly template: 'reminder'
  readonly values: ReminderValues
  /** The owner conversation that gets the notice. */
  readonly sessionId: string
  readonly status: MissionStatus
  /** Epoch milliseconds of the next run. Undefined after the mission ends. */
  readonly nextRunAt?: number
  readonly lastRunAt?: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** A template as the mission tools describe it to the model. */
export interface MissionTemplate {
  readonly name: MissionInstance['template']
  /** When the template fits. */
  readonly description: string
  /** The values that the model gives, in short form. */
  readonly values: string
}

/** The built-in templates. The mission tools list them in their description, so each entry stays short. */
export const MISSION_TEMPLATES: readonly MissionTemplate[] = [
  {
    name: 'reminder',
    description: 'Tell the owner something at a time that the owner asked for. You always speak when it is due. Message times have no seconds, so never count a clock time from them: use an "after" start for any time from now.',
    values: '{ "text": what to tell, in the owner\'s words, "start": { "kind": "after", "minutes": n } for a time from now, for example "in 1 minute" or "in 2 hours", or { "kind": "at", "at": local "YYYY-MM-DDTHH:mm" } only for a clock time that the owner names, for example "at 18:00", "repeat": { "kind": "once" | "daily" | "weekdays" } or { "kind": "weekly", "days": [0-6, 0 is Sunday] } or { "kind": "interval", "minutes": 15-1440 } }',
  },
]

const MINUTE_MS = 60_000

/** Limits of a new reminder. */
const REMINDER_LIMITS = {
  /** A clock time in the current minute is still valid, so an `at` first run can be this much in the past. */
  pastSlackMs: MINUTE_MS,
  /** A reminder this far ahead is more likely a wrong date than a real request. */
  maxAheadMs: 366 * 24 * 60 * MINUTE_MS,
  maxTextLength: 200,
  /** A shorter interval makes the character talk too often. */
  minIntervalMinutes: 15,
  maxIntervalMinutes: 24 * 60,
}

/** How the leader sorts due runs. */
export interface MissionScheduleOptions {
  /**
   * A run that is late by this much or less is on time. The leader checks the clock each second, but a hidden web tab
   * can delay timers by up to one minute.
   * @default 120000
   */
  lateAfterMs: number
  /**
   * A run that is later than `lateAfterMs` and not later than this came due while the app was closed. The owner still
   * gets a notice. An older run only changes the state.
   * @default 86400000
   */
  missedAgeLimitMs: number
}

const DEFAULT_SCHEDULE_OPTIONS: MissionScheduleOptions = {
  lateAfterMs: 120_000,
  missedAgeLimitMs: 24 * 60 * 60_000,
}

/**
 * Reads a local date and time in the form `YYYY-MM-DDTHH:mm`. It refuses other forms and dates that do not exist.
 *
 * @example
 * parseLocalDateTime('2026-10-31T18:00')
 * // => new Date(2026, 9, 31, 18, 0).getTime()
 * parseLocalDateTime('2026-02-30T18:00')
 * // => undefined
 */
export function parseLocalDateTime(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text.trim())
  if (!match)
    return undefined
  const [year, month, day, hours, minutes] = match.slice(1).map(Number) as [number, number, number, number, number]
  const date = new Date(year, month - 1, day, hours, minutes)
  // `Date` rolls an invalid day or hour into the next unit, so a value that changed on the way in did not exist.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hours || date.getMinutes() !== minutes)
    return undefined
  return date.getTime()
}

/**
 * Writes epoch milliseconds as a local date and time in the form `YYYY-MM-DDTHH:mm`. Seconds are dropped.
 *
 * @example
 * formatLocalDateTime(new Date(2026, 9, 31, 18, 5, 30).getTime())
 * // => '2026-10-31T18:05'
 */
export function formatLocalDateTime(time: number) {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Creates a reminder from the request that the model gave. On a refusal, `reason` tells the model what to change.
 *
 * - An `after` start runs first at `now` plus the minutes, to the second. `at` keeps that time without seconds.
 * - The first run of a daily, weekday, or weekly reminder is the first matching day at or after the start.
 * - The first run of an interval reminder is the first step at or after the start.
 */
export function createReminder(input: { id: string, sessionId: string, request: ReminderRequest, now: number }): { ok: true, mission: MissionInstance } | { ok: false, reason: string } {
  const text = input.request.text.trim()
  if (!text)
    return { ok: false, reason: 'The reminder needs a text.' }
  if (text.length > REMINDER_LIMITS.maxTextLength)
    return { ok: false, reason: `The reminder text has more than ${REMINDER_LIMITS.maxTextLength} characters. Make it shorter.` }

  const repeat = normalizeRepeat(input.request.repeat)
  if (typeof repeat === 'string')
    return { ok: false, reason: repeat }

  const startAt = resolveStart(input.request.start, input.now)
  if (typeof startAt === 'string')
    return { ok: false, reason: startAt }

  const values: ReminderValues = { text, at: startAt.at, repeat }
  const firstRun = firstRunOf(values, startAt, input.now)
  if (firstRun === undefined || firstRun < input.now - REMINDER_LIMITS.pastSlackMs)
    return { ok: false, reason: 'The time is in the past. Use a future time.' }
  if (firstRun > input.now + REMINDER_LIMITS.maxAheadMs)
    return { ok: false, reason: 'The time is more than one year ahead.' }

  return {
    ok: true,
    mission: {
      id: input.id,
      template: 'reminder',
      values,
      sessionId: input.sessionId,
      status: 'scheduled',
      nextRunAt: firstRun,
      createdAt: input.now,
      updatedAt: input.now,
    },
  }
}

/**
 * Sorts the scheduled runs that are due at `now`.
 *
 * - `due`: on time. Each one gets its own notice.
 * - `missed`: late, inside the age limit. They share one notice, so the character does not speak many times after a start.
 * - `expired`: older than the age limit. They get no notice.
 */
export function collectDueMissions(missions: readonly MissionInstance[], now: number, options: Partial<MissionScheduleOptions> = {}) {
  const { lateAfterMs, missedAgeLimitMs } = { ...DEFAULT_SCHEDULE_OPTIONS, ...options }
  const due: MissionInstance[] = []
  const missed: MissionInstance[] = []
  const expired: MissionInstance[] = []
  for (const mission of missions) {
    if (mission.status !== 'scheduled' || mission.nextRunAt === undefined || mission.nextRunAt > now)
      continue
    const lateness = now - mission.nextRunAt
    if (lateness <= lateAfterMs)
      due.push(mission)
    else if (lateness <= missedAgeLimitMs)
      missed.push(mission)
    else
      expired.push(mission)
  }
  return { due, missed, expired }
}

/**
 * Moves a mission past its current run.
 * A repeated reminder takes its next run after `now`, so runs that the app missed while closed do not come one by one.
 * A reminder that runs once ends: `done` after delivery, `missed` when it expired without a notice.
 */
export function settleMissionRun(mission: MissionInstance, outcome: 'delivered' | 'expired', now: number): MissionInstance {
  const lastRunAt = outcome === 'delivered' ? now : mission.lastRunAt
  const nextRunAt = nextRunAfter(mission, now)
  if (nextRunAt !== undefined)
    return { ...mission, nextRunAt, lastRunAt, updatedAt: now }

  const { nextRunAt: _ended, ...rest } = mission
  return { ...rest, status: outcome === 'delivered' ? 'done' : 'missed', lastRunAt, updatedAt: now }
}

/** Stops a mission. A stopped mission never runs again. */
export function stopMission(mission: MissionInstance, now: number): MissionInstance {
  const { nextRunAt: _ended, ...rest } = mission
  return { ...rest, status: 'stopped', updatedAt: now }
}

/** What happened to one notice: a reply with text was stored, no reply was stored, or the send failed. */
export type NoticeOutcome = 'spoke' | 'silent' | 'failed' | 'skipped'

/** Sends one `mustSpeak` notice to the owner conversation. The host binds it to the conversation. */
export type MustSpeakNotify = (notice: { source: string, text: string, reply?: string }) => Promise<NoticeOutcome>

/**
 * Makes sure that the owner hears a reminder, in this order:
 * 1. The notice asks the model to speak.
 * 2. If the reply was empty, the notice goes again one time. A failed call skips this try, because it fails again.
 * 3. If the reply is still empty, or the call failed, the character speaks the fixed text without a model call.
 *
 * Resolves to `spoke` when the model spoke, `fixed` when the fixed text played, and `unspoken` when nothing played.
 * On `unspoken`, the host shows the fixed text in another way, for example an operating system notification.
 */
export async function deliverReminder(notify: MustSpeakNotify, text: string, fixedText: string): Promise<'spoke' | 'fixed' | 'unspoken'> {
  let outcome = await notify({ source: 'mission:reminder', text })
  if (outcome === 'silent')
    outcome = await notify({ source: 'mission:reminder', text: `The owner has not heard this yet.\n${text}` })
  if (outcome === 'spoke')
    return 'spoke'

  const fixed = await notify({
    source: 'mission:reminder:fixed',
    text: 'The model gave no reply, so the app spoke the reminder with a fixed text.',
    reply: fixedText,
  })
  return fixed === 'spoke' ? 'fixed' : 'unspoken'
}

/** The notice for one reminder that is due now. The `mustSpeak` notice option tells the model to speak. */
export function reminderNoticeText(mission: MissionInstance) {
  return `Reminder that the owner asked for, ${formatRun(mission)}: ${mission.values.text}`
}

/** One notice for all reminders that came due while the app was closed, oldest first. */
export function missedRemindersNoticeText(missions: readonly MissionInstance[]) {
  const lines = [...missions]
    .sort((left, right) => (left.nextRunAt ?? 0) - (right.nextRunAt ?? 0))
    .map(mission => `- ${formatRun(mission)}: ${mission.values.text}`)
  return [`The app was closed, so ${missions.length === 1 ? 'this reminder comes' : 'these reminders come'} late:`, ...lines].join('\n')
}

function formatRun(mission: MissionInstance) {
  // A due mission always has a run time. The creation time only labels a run that a caller passes after it ended.
  return `due ${formatTimePrefix(mission.nextRunAt ?? mission.createdAt).trim()}`
}

/** Checks the repeat. Resolves to the cleaned repeat, or to the reason for a refusal. */
function normalizeRepeat(repeat: ReminderRepeat): ReminderRepeat | string {
  if (repeat.kind === 'interval') {
    const { minIntervalMinutes: min, maxIntervalMinutes: max } = REMINDER_LIMITS
    if (!Number.isInteger(repeat.minutes) || repeat.minutes < min || repeat.minutes > max)
      return `An interval reminder needs a whole number of minutes from ${min} to ${max}.`
    return repeat
  }
  if (repeat.kind !== 'weekly')
    return repeat
  const days = [...new Set(repeat.days)].filter(day => Number.isInteger(day) && day >= 0 && day <= 6).sort((left, right) => left - right)
  return days.length ? { kind: 'weekly', days } : 'A weekly reminder needs at least one day from 0 to 6.'
}

/**
 * Finds the start time. Resolves to that time, or to the reason for a refusal.
 * `exact` marks an `after` start. Its time keeps the seconds, and `at` drops them.
 */
function resolveStart(start: ReminderStart, now: number): { at: string, time: number, exact: boolean } | string {
  if (start.kind === 'after') {
    if (!Number.isInteger(start.minutes) || start.minutes < 1)
      return 'The minutes from now must be a whole number of 1 or more.'
    const time = now + start.minutes * MINUTE_MS
    return { at: formatLocalDateTime(time), time, exact: true }
  }
  const time = parseLocalDateTime(start.at)
  if (time === undefined)
    return 'The time must be a real local date and time in the form YYYY-MM-DDTHH:mm.'
  return { at: start.at.trim(), time, exact: false }
}

function firstRunOf(values: ReminderValues, start: { time: number, exact: boolean }, now: number) {
  // An exact start runs at its own time when the repeat allows that day. A weekday or weekly reminder that starts on
  // another day runs first on its next allowed day, at the time of day of `at`.
  if (start.exact)
    return repeatsOn(values.repeat, new Date(start.time).getDay()) ? start.time : runAtOrAfter(values, start.time)
  // A repeated reminder whose first time has passed starts on its next run. A reminder that runs once has only its own time.
  return runAtOrAfter(values, values.repeat.kind === 'once' ? start.time : Math.max(start.time, now - REMINDER_LIMITS.pastSlackMs))
}

/** The first step of `minutes` after `anchor` that is at or after `from`. */
function stepAtOrAfter(anchor: number, minutes: number, from: number) {
  // An interval counts real time, so a daylight saving change moves the wall clock time of the runs.
  const step = minutes * MINUTE_MS
  return anchor + Math.max(0, Math.ceil((from - anchor) / step)) * step
}

function repeatsOn(repeat: ReminderRepeat, day: number) {
  switch (repeat.kind) {
    case 'once':
    case 'daily':
    case 'interval':
      return true
    case 'weekdays':
      return day >= 1 && day <= 5
    case 'weekly':
      return repeat.days.includes(day)
  }
}

/**
 * The first run at or after `from`. A daily, weekday, or weekly reminder runs at the time of day of `at`, on a day that
 * the repeat allows. An interval reminder runs on the steps from `at`.
 */
function runAtOrAfter(values: ReminderValues, from: number) {
  const start = parseLocalDateTime(values.at)
  if (start === undefined)
    return undefined
  if (values.repeat.kind === 'once')
    return start >= from ? start : undefined
  if (values.repeat.kind === 'interval')
    return stepAtOrAfter(start, values.repeat.minutes, from)

  const startDate = new Date(start)
  const candidate = new Date(Math.max(from, start))
  // Each candidate keeps the local time of day of `at`. `setDate` moves by calendar days, so a daylight saving change
  // keeps the same wall clock time.
  candidate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0)
  for (let offset = 0; offset <= 8; offset++) {
    if (candidate.getTime() >= from && candidate.getTime() >= start && repeatsOn(values.repeat, candidate.getDay()))
      return candidate.getTime()
    candidate.setDate(candidate.getDate() + 1)
  }
  return undefined
}

function nextRunAfter(mission: MissionInstance, after: number) {
  const { values } = mission
  if (values.repeat.kind === 'once')
    return undefined
  // Each run of an interval reminder is a whole number of intervals after the current one, so an exact first run keeps
  // its seconds.
  if (values.repeat.kind === 'interval' && mission.nextRunAt !== undefined)
    return stepAtOrAfter(mission.nextRunAt, values.repeat.minutes, after + 1)
  return runAtOrAfter(values, after + 1)
}
