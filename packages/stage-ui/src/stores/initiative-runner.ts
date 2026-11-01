import type { ChatAttachment, InitiativeDecision, InitiativeEvent, InitiativeHost, InitiativeRhythm, InitiativeScreenContext, InitiativeState, InitiativeTime, InitiativeWaitReason, MissionInstance, SpeechType, TimelineNote, TopicSeed } from '@proj-airi/core-agent'
import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import type { OwnerPresence, OwnerPresenceSource } from '../libs/initiative/presence'

import { errorMessageFrom } from '@moeru/std'
import {
  calendarTopicSeeds,
  createInitiativeState,
  currentTopicThread,
  decideInitiative,
  decideInterruption,
  initiativeNoticeText,
  initiativeReadout,
  initiativeTimeFrom,
  observeInitiative,
  pickTopicSeeds,
  requestRhythmTurn,
  resolveInitiativeOptions,
  TOPIC_LIMITS,
  topicOf,
  topicVariety,
} from '@proj-airi/core-agent'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { computed, onScopeDispose, readonly, shallowRef, watch } from 'vue'

import { extractMessageText } from '../libs/chat-sync/wire-message'
import { INITIATIVE_SOURCE, initiativeConversationFacts, initiativeEventOf } from '../libs/initiative/conversation'
import { markAway, observePresence, OWNER_PRESENCE_LIMITS, shouldGreet } from '../libs/initiative/presence'
import { initiativeTopicLines, memoryTopicSeeds } from '../libs/initiative/topics'
import { isOwnerTyping } from '../libs/initiative/typing'
import { eventPressureFactor, IMAGE_BUDGET_LIMITS } from '../libs/perception/image-budget'
import { buildScreenTurn } from '../libs/perception/screen-turn'
import { Ticker } from '../workers/ticker'
import { useSpeakingStore } from './audio'
import { useChatStore } from './chat'
import { useChatSessionStore } from './chat/session-store'
import { useInitiativeStore } from './initiative'
import { useInitiativeInspectorStore } from './initiative-inspector'
import { useIntentionsStore } from './intentions'
import { useMemoryStore } from './memory'
import { useMissionsStore } from './missions'
import { useOwnerTypingStore } from './owner-typing'
import { usePerceptionStore } from './perception'
import { usePerceptionRunnerStore } from './perception-runner'
import { useSpeechOutputControlStore } from './speech-output-control'
import { useTimelineStore } from './timeline'
import { useVoiceStore } from './voice'
import { useVoiceMessagesStore } from './voice-messages'

/** The policy decides once each second. The drive changes slowly, so a finer check adds nothing. */
const TICK_INTERVAL_MS = 1_000

const DAY_MS = 24 * 60 * 60_000
/** A mission change counts as a timeline note only when it happened this recently. */
const MISSION_NOTE_WINDOW_MS = 60_000
/** The first turn with the screen treats the frames of this time as news. */
const FIRST_SCREEN_TURN_LOOKBACK_MS = 60_000

/** The note that the timeline gets when a mission starts or ends. */
function missionNote(mission: MissionInstance, change: 'started' | 'ended') {
  switch (mission.template) {
    case 'small-talk':
      return `Mission ${change}: small talk (${mission.values.minutes} min)`
    case 'commentary':
      return `Mission ${change}: commentary on ${mission.values.app}`
    case 'watch':
      return `Mission ${change}: watch "${mission.values.condition}" in ${mission.values.app}`
    case 'reminder':
      return `Mission ${change}: reminder "${mission.values.text}"`
  }
}

/** The recent autonomous turns that the runner remembers, so it interrupts only its own speech. */
const RECENT_TURN_COUNT = 5

/** Gates that hold for longer than a pending rhythm turn waits. A greeting or a welcome back then never starts. */
const LASTING_WAIT_REASONS: readonly InitiativeWaitReason[] = ['quiet-hours', 'owner-quiet', 'daily-budget']

/**
 * Runs autonomous speech on the renderer leader: the character starts to talk without an owner message.
 *
 * State model:
 * - The policy state of `@proj-airi/core-agent` lives here, in memory only. A restart or a new leader starts rested and
 *   not bored. Turning the feature off drops the state.
 * - Each tick asks `decideInitiative`. On a turn, a transient notice goes to the conversation that the owner has open.
 *   History keeps the reply only, so silent turns leave no trace.
 * - Stored messages of that conversation feed the policy: an owner message, and a reply that no autonomous turn started.
 * - Topics flow. The model ends each line with a topic label, and the reply keeps it. Each drive turn reads the lines
 *   of recent days: the current thread and its heat, and a few seeds from the memory index and the calendar that are
 *   far from the recent topics. A seed that a spoken turn offered rests for six hours. A cold thread asks the model
 *   for a new topic.
 * - Small talk that the owner asked for makes the idle pace faster, and the situation block names it. When the owner
 *   leaves, the runner ends the small talk.
 * - Screen perception feeds the drive: each screen event adds pressure by its salience, less when the image budget
 *   runs low. A drive turn while perception runs attaches the frames that `fresh-keyframes` picks, inside the image
 *   budget. The notice keeps them out of history, so they never reach the disk.
 * - While perception runs, code writes timeline notes: app switches, owner messages, and mission starts and ends. A
 *   drive turn with the screen gives the timeline of the conversation to the model, which adds notes with markers.
 * - Commentary that the owner asked for switches the policy to its commentary mode, with a pace that follows the screen
 *   activity. The perception runner then captures the window of its app. When that window closes, the commentary ends.
 *   A very large screen event interrupts the commentary line that plays: the sentence ends first, or the largest events
 *   cut it at once. The timeline notes the cut line.
 * - The open intentions add drive, and the situation block lists them. The owner's temporary changes, for example a
 *   quiet time, change the options at each tick.
 * - While a window watches the inspector, each tick publishes a readout of the policy to it.
 * - The daily rhythm adds two turns that the drive does not start. At app start, a conversation quiet for hours gets a
 *   greeting. When the owner comes back after time away, the character welcomes the owner back. The presence source of
 *   the app tells when the owner left and came back. A rhythm turn that the gates hold for two minutes is dropped.
 * - Owner input wins. The owner types in a chat input of any window, speaks, or queues a message. Then no turn starts,
 *   and a turn in flight is cancelled and closes as `dropped`. A dropped turn keeps its drive, so the character speaks
 *   again with fresh context once the owner stops.
 *
 * Use when:
 * - An app starts its renderer. Call `initialize` once with the synced Pinia runtime.
 */
export const useInitiativeRunnerStore = defineStore('initiative-runner', () => {
  const initiative = useInitiativeStore()
  const intentions = useIntentionsStore()
  const chat = useChatStore()
  const chatSession = useChatSessionStore()
  const speaking = useSpeakingStore()
  const voice = useVoiceStore()
  const voiceMessages = useVoiceMessagesStore()
  const ownerTyping = useOwnerTypingStore()
  const inspector = useInitiativeInspectorStore()
  const memory = useMemoryStore()
  const missions = useMissionsStore()
  const perception = usePerceptionStore()
  const perceptionRunner = usePerceptionRunnerStore()
  const timeline = useTimelineStore()
  const speechControl = useSpeechOutputControlStore()
  /** The newest autonomous turns, so an interruption stops only speech that this runner started. */
  const recentTurnIds: string[] = []
  /** The largest screen salience since the last turn started, and the one that the current line answers. */
  let salienceSinceTurn = 0
  let lineSalience = 0
  let lastInterruptAt: number | undefined
  const { activeSessionId } = storeToRefs(chatSession)

  /** The policy state. Undefined while the feature is off or this renderer does not lead. */
  const state = shallowRef<InitiativeState>()
  /** The autonomous turn in flight. The policy holds one turn at most. */
  let running: { sessionId: string, turnId: string, dropped: boolean } | undefined
  const ticker = new Ticker(TICK_INTERVAL_MS, tick)
  let leadership: SyncedPiniaRuntime | undefined
  let stopLeadershipListener: (() => void) | undefined
  let presenceSource: OwnerPresenceSource | undefined
  let stopAwayListener: (() => void) | undefined
  /** Whether the owner is away now. The leader reads the presence source to keep it. */
  const presence = shallowRef<OwnerPresence>({})
  let lastPresenceReadAt = 0
  /** Whether this runner checked the greeting of this app start. It greets once at most. */
  let greetingChecked = false
  /** A greeting or a welcome back that waits for the gates. */
  let pendingRhythm: { rhythm: InitiativeRhythm, until: number, awayMs?: number } | undefined
  /** The last greeting or welcome back that started, for the inspector and the gap between them. */
  const lastRhythm = shallowRef<{ rhythm: InitiativeRhythm, at: number }>()
  /** The hinted speech types of today's spoken turns, for the variety in the inspector. It is runtime state only. */
  let spokenTypes: { day: string, types: SpeechType[] } = { day: '', types: [] }
  /** The seeds of the last drive turn, for the inspector. */
  let lastSeeds: TopicSeed[] = []
  /** When a spoken turn last offered each seed. A seed rests for a while after that. It is runtime state only. */
  const seedOfferedAt = new Map<string, number>()
  /** When the last turn with the screen started. Later frames and events are news to the model. */
  let lastScreenTurnAt: number | undefined

  const ownerSpeaking = computed(() => voiceMessages.isRecording || voice.state?.phase === 'capturing')
  const activeMessages = computed(() => chatSession.getSessionMessagesIfLoaded(activeSessionId.value))

  /** The small talk that runs at `now`. Missions that are off run no small talk. */
  function smallTalkAt(now: number) {
    return missions.enabled ? missions.smallTalkAt(now) : undefined
  }

  /** The commentary that runs at `now`. Missions that are off run no commentary. */
  function commentaryAt(now: number) {
    return missions.enabled ? missions.commentaryAt(now) : undefined
  }

  /**
   * The options at `now`. The owner's temporary changes and the foreground missions end on their own, so each call
   * reads them again. Commentary paces itself by the screen activity.
   */
  function optionsAt(now: number) {
    const commentary = commentaryAt(now)
    return resolveInitiativeOptions(initiative.settingsAt(now, {
      smallTalk: Boolean(smallTalkAt(now)),
      ...(commentary ? { commentaryActivity: perceptionRunner.activity() } : {}),
    }))
  }

  function host(now: number): InitiativeHost {
    return {
      ownerActive: ownerSpeaking.value || isOwnerTyping(ownerTyping.typingUntil, now),
      speechPlaying: speaking.nowSpeaking,
      turnRunning: chat.sending || chat.activeTurns.length > 0,
      intentions: intentions.openAt(now).length,
    }
  }

  function observe(event: InitiativeEvent) {
    if (!state.value)
      return
    const time = initiativeTimeFrom(new Date())
    state.value = observeInitiative(state.value, event, time, optionsAt(time.now))
  }

  /** Cancels the turn in flight. Its speech is stale, because the owner comes first. */
  function dropRunningTurn() {
    if (!running || running.dropped)
      return
    running.dropped = true
    void chat.cancelTurn({ sessionId: running.sessionId, turnId: running.turnId })
  }

  /** The autonomous lines of a conversation in the recent days that topics avoid. */
  function recentTopicLines(sessionId: string, now: number) {
    return initiativeTopicLines(chatSession.getSessionMessages(sessionId), now - TOPIC_LIMITS.recentDays * DAY_MS)
  }

  /** The current thread and a few seeds far from the recent topics. */
  function topicsOf(sessionId: string, time: InitiativeTime) {
    const lines = recentTopicLines(sessionId, time.now)
    const thread = currentTopicThread(lines)
    const pool = [
      ...(memory.enabled ? memoryTopicSeeds(memory.entries, chat.personaOf(sessionId)) : []),
      ...calendarTopicSeeds(time.localDay),
    ]
    for (const [text, at] of seedOfferedAt) {
      if (time.now - at >= TOPIC_LIMITS.seedRestMs)
        seedOfferedAt.delete(text)
    }
    const seeds = pickTopicSeeds({ seeds: pool, recentTopics: lines.map(topicOf), resting: [...seedOfferedAt.keys()], random: Math.random })
    return { thread, seeds }
  }

  /**
   * The screen part of a drive turn while perception runs and no excluded window is in front. Records the frames that
   * go to the model in the image budget.
   */
  async function screenOf(now: number): Promise<{ context: InitiativeScreenContext, attachments: ChatAttachment[] } | undefined> {
    if (!perception.enabled || !perceptionRunner.running() || perceptionRunner.excludedNow())
      return undefined
    try {
      const commentary = Boolean(commentaryAt(now))
      const turn = await buildScreenTurn({
        frames: perceptionRunner.frames(),
        events: perceptionRunner.events(),
        ...(perceptionRunner.foregroundApp() ? { app: perceptionRunner.foregroundApp() } : {}),
        budget: perception.budgetAt(now, commentary),
        ...(commentary ? { maxImagesPerTurn: IMAGE_BUDGET_LIMITS.maxCommentaryImagesPerTurn } : {}),
        since: lastScreenTurnAt ?? now - FIRST_SCREEN_TURN_LOOKBACK_MS,
        now,
      })
      lastScreenTurnAt = now
      if (turn.attachments.length)
        perception.recordImages(turn.attachments.length, now)
      return turn
    }
    catch (error) {
      console.warn('[initiative] Failed to prepare the screen frames:', errorMessageFrom(error))
      return undefined
    }
  }

  async function runTurn(decision: Extract<InitiativeDecision, { kind: 'turn' }>, sessionId: string, awayMs?: number) {
    const date = new Date()
    const time = initiativeTimeFrom(date)
    const facts = initiativeConversationFacts(chatSession.getSessionMessages(sessionId))
    // A greeting and a welcome back have their own reason. Topic ideas would pull them away from it.
    const rhythm = decision.trigger === 'greeting' || decision.trigger === 'welcome-back'
    const topics = rhythm ? undefined : topicsOf(sessionId, time)
    const smallTalk = rhythm ? undefined : smallTalkAt(time.now)
    lastSeeds = topics?.seeds ?? []
    const screen = rhythm ? undefined : await screenOf(time.now)
    const screenTimeline = screen ? await timeline.load(sessionId).catch(() => timeline.timelineOf(sessionId)) : undefined
    const text = initiativeNoticeText({
      mode: state.value?.mode ?? 'idle',
      trigger: decision.trigger,
      ...(decision.speechType ? { speechType: decision.speechType } : {}),
      now: time.now,
      localMinutes: time.localMinutes,
      ...facts,
      intentions: intentions.openAt(time.now),
      ...(awayMs !== undefined ? { awayMs } : {}),
      ...(smallTalk ? { smallTalkEndsAt: smallTalk.values.endsAt } : {}),
      ...(screen ? { screen: screen.context } : {}),
      ...(screenTimeline ? { timeline: screenTimeline } : {}),
      ...(topics?.thread ? { thread: topics.thread } : {}),
      ...(topics?.seeds.length ? { seeds: topics.seeds } : {}),
    })
    const turn = { sessionId, turnId: nanoid(), dropped: false }
    running = turn
    recentTurnIds.push(turn.turnId)
    recentTurnIds.splice(0, Math.max(0, recentTurnIds.length - RECENT_TURN_COUNT))
    lineSalience = salienceSinceTurn
    salienceSinceTurn = 0
    let outcome: 'spoke' | 'silent' | 'dropped' | 'failed' = 'failed'
    try {
      const result = await chat.notifyConversation(sessionId, { source: INITIATIVE_SOURCE, text, transient: true, ...(screen?.attachments.length ? { attachments: screen.attachments } : {}) }, turn.turnId)
      outcome = turn.dropped ? 'dropped' : result === 'spoke' ? 'spoke' : result === 'failed' ? 'failed' : 'silent'
    }
    catch (error) {
      console.warn('[initiative] Failed to run an autonomous turn:', errorMessageFrom(error))
    }
    finally {
      running = undefined
    }
    if (outcome === 'spoke') {
      for (const seed of topics?.seeds ?? [])
        seedOfferedAt.set(seed.text, time.now)
    }
    if (outcome === 'spoke' && decision.speechType) {
      const day = initiativeTimeFrom(new Date()).localDay
      spokenTypes = { day, types: [...(spokenTypes.day === day ? spokenTypes.types : []), decision.speechType] }
    }
    observe({ type: 'turn-finished', outcome })
  }

  function tick() {
    if (!leadership?.isLeader() || !initiative.enabled) {
      state.value = undefined
      return
    }
    // The situation block reads the open conversation, so a turn waits until its messages are loaded.
    const sessionId = activeSessionId.value
    if (!activeMessages.value)
      return

    const time = initiativeTimeFrom(new Date())
    const currentHost = host(time.now)
    const options = optionsAt(time.now)
    checkGreeting(time.now)
    readPresence(time.now)

    let current = state.value ?? createInitiativeState(time)
    // The policy follows the foreground mission: commentary has its own pace.
    const mode = commentaryAt(time.now) ? 'commentary' : 'idle'
    if (current.mode !== mode)
      current = observeInitiative(current, { type: 'mode-changed', mode }, time, options)
    const rhythm = pendingRhythm && pendingRhythm.until > time.now ? pendingRhythm : undefined
    const { state: next, decision } = rhythm
      ? requestRhythmTurn(current, rhythm.rhythm, currentHost, time, options)
      : decideInitiative(current, currentHost, time, Math.random, options)
    state.value = next
    if (!rhythm || decision.kind === 'turn' || LASTING_WAIT_REASONS.includes(decision.reason))
      pendingRhythm = undefined
    if (rhythm && decision.kind === 'turn')
      lastRhythm.value = { rhythm: rhythm.rhythm, at: time.now }

    if (inspector.isWatched(time.now))
      inspector.publish(initiativeReadout(next, currentHost, time, options), time.now, { awaySince: presence.value.awaySince, lastRhythm: lastRhythm.value }, topicReadout(sessionId, time))
    if (decision.kind === 'turn')
      void runTurn(decision, sessionId, rhythm?.awayMs)
  }

  /** The current thread, the last seeds, and the variety of today's lines, for the inspector. */
  function topicReadout(sessionId: string, time: InitiativeTime) {
    const lines = recentTopicLines(sessionId, time.now)
    const midnight = new Date(time.now).setHours(0, 0, 0, 0)
    const thread = currentTopicThread(lines)
    return {
      ...(thread ? { thread } : {}),
      seeds: lastSeeds.map(seed => seed.text),
      variety: topicVariety(lines.filter(line => line.at >= midnight), spokenTypes.day === time.localDay ? spokenTypes.types : []),
    }
  }

  /** At the first tick with the open conversation, a conversation quiet for hours gets a greeting. */
  function checkGreeting(now: number) {
    if (greetingChecked)
      return
    greetingChecked = true
    const facts = initiativeConversationFacts(activeMessages.value ?? [])
    const lastMessageAt = Math.max(facts.lastOwnerAt ?? -Infinity, facts.lastSpokeAt ?? -Infinity)
    if (initiative.greetingEnabled && shouldGreet(Number.isFinite(lastMessageAt) ? lastMessageAt : undefined, now))
      pendingRhythm = { rhythm: 'greeting', until: now + OWNER_PRESENCE_LIMITS.rhythmHoldMs }
  }

  /** Reads the idle time now and then. A return after a long absence asks for a welcome back. */
  function readPresence(now: number) {
    if (!presenceSource || now - lastPresenceReadAt < OWNER_PRESENCE_LIMITS.pollMs)
      return
    lastPresenceReadAt = now
    void presenceSource.idleMs().then((idleMs) => {
      const readAt = Date.now()
      const { presence: next, returnedAfterMs } = observePresence(presence.value, idleMs, readAt)
      presence.value = next
      const recentRhythm = lastRhythm.value && readAt - lastRhythm.value.at < OWNER_PRESENCE_LIMITS.rhythmGapMs
      if (returnedAfterMs !== undefined && returnedAfterMs >= OWNER_PRESENCE_LIMITS.welcomeBackAfterMs && initiative.welcomeBackEnabled && !recentRhythm && !pendingRhythm)
        pendingRhythm = { rhythm: 'welcome-back', until: readAt + OWNER_PRESENCE_LIMITS.rhythmHoldMs, awayMs: returnedAfterMs }
    }).catch(error => console.warn('[initiative] Failed to read the idle time:', errorMessageFrom(error)))
  }

  // Each new message of the open conversation can change the drive. A switch to another conversation is not an event.
  let lastMessage: { sessionId: string, id?: string } | undefined
  watch(() => activeMessages.value?.at(-1), (message) => {
    const sessionId = activeSessionId.value
    const seen = lastMessage
    lastMessage = { sessionId, id: message?.id }
    if (!message || !seen || seen.sessionId !== sessionId || seen.id === message.id)
      return
    const event = initiativeEventOf(message)
    if (!event)
      return
    if (event.type === 'owner-message') {
      dropRunningTurn()
      noteScreenHistory([{ at: message.createdAt ?? Date.now(), text: 'The owner sent a message', source: 'code' }])
    }
    observe(event)
  })

  // Small talk ends when the owner leaves the device. Only the leader writes the end.
  watch(() => presence.value.awaySince, (awaySince) => {
    if (awaySince !== undefined && leadership?.isLeader() && smallTalkAt(Date.now()))
      void missions.endForeground('away', 'small-talk').catch(error => console.warn('[initiative] Failed to end small talk:', errorMessageFrom(error)))
  })

  /** Adds code notes to the timeline of the open conversation, while this renderer leads and perception runs. */
  function noteScreenHistory(notes: readonly TimelineNote[]) {
    if (!leadership?.isLeader() || !perceptionRunner.running() || !notes.length)
      return
    void timeline.addNotes(activeSessionId.value, notes).catch(error => console.warn('[initiative] Failed to write the timeline:', errorMessageFrom(error)))
  }

  /**
   * Interrupts the commentary line that plays now for a very large event. The current sentence ends first, unless the
   * event is one of the largest. The new event then starts the next line, and the timeline notes the cut.
   */
  function interruptForEvent(salience: number, now: number) {
    if (!commentaryAt(now) || !speaking.nowSpeaking)
      return
    const decision = decideInterruption({ salience, lineSalience, ...(lastInterruptAt !== undefined ? { lastInterruptAt } : {}), now })
    const turns = speechControl.activeTurns.filter(turn => recentTurnIds.includes(turn.turnId))
    if (decision === 'none' || !turns.length)
      return
    lastInterruptAt = now
    void speechControl.interruptTurns(turns, { cause: 'commentary-event', afterCurrentClip: decision === 'after-sentence' })
      .catch(error => console.warn('[initiative] Failed to interrupt the commentary line:', errorMessageFrom(error)))
    const cut = chatSession.getSessionMessages(activeSessionId.value).findLast(message => message.role === 'assistant' && message.proactive && turns.some(turn => turn.turnId === message.proactive?.turnId))
    const text = cut ? extractMessageText(cut).trim().slice(0, 80) : ''
    noteScreenHistory([{ at: now, text: text ? `A new event cut the line "${text}"` : 'A new event cut the commentary line', source: 'code' }])
  }

  // Each screen event pushes the drive. A low image budget weakens it, so turns with frames come less often.
  const stopScreenEvents = perceptionRunner.onEvents((events) => {
    noteScreenHistory(events.flatMap(event => event.type === 'app-switch' ? [{ at: event.at, text: `The owner switched to ${event.app}`, source: 'code' as const }] : []))
    if (!state.value)
      return
    const now = Date.now()
    const largest = Math.max(...events.map(event => event.salience))
    salienceSinceTurn = Math.max(salienceSinceTurn, largest)
    interruptForEvent(largest, now)
    // The policy counts salience squared, so the square root of the factor scales the pressure by the factor.
    const scale = Math.sqrt(eventPressureFactor(perception.budgetAt(now, Boolean(commentaryAt(now)))))
    for (const event of events)
      observe({ type: 'perceived', salience: event.salience * scale })
  })

  // A commentary or a watch looks at the window of its app. The perception runner captures it, and its close ends the
  // mission. A commentary wins over a watch, and the watch then waits until its app is in front.
  watch(() => {
    if (!missions.enabled)
      return undefined
    const commentary = missions.active.find(mission => mission.template === 'commentary')
    const watching = missions.active.find(mission => mission.template === 'watch')
    if (commentary?.template === 'commentary')
      return commentary.values.app
    return watching?.template === 'watch' ? watching.values.app : undefined
  }, app => perceptionRunner.setTarget(app), { immediate: true })
  const stopTargetClosed = perceptionRunner.onTargetClosed((app) => {
    if (!leadership?.isLeader())
      return
    const target = missions.active.find(mission => (mission.template === 'commentary' || mission.template === 'watch') && mission.values.app === app)
    if (target)
      void missions.stop(target.id, 'target-closed').catch(error => console.warn('[initiative] Failed to end the mission of a closed window:', errorMessageFrom(error)))
  })

  // A mission that starts or ends is part of what happened while the character watched the screen. The first read of
  // the stored missions also changes the list, so only a change of the last minute counts.
  let knownMissions = new Map<string, MissionInstance>()
  watch(() => missions.active, (active) => {
    const now = Date.now()
    const recent = (at: number) => now - at < MISSION_NOTE_WINDOW_MS
    const next = new Map(active.map(mission => [mission.id, mission]))
    const started = active.filter(mission => !knownMissions.has(mission.id) && recent(mission.createdAt))
    const ended = missions.missions.filter(mission => knownMissions.has(mission.id) && !next.has(mission.id) && recent(mission.updatedAt))
    noteScreenHistory([
      ...started.map(mission => ({ at: mission.createdAt, text: missionNote(mission, 'started'), source: 'code' as const })),
      ...ended.map(mission => ({ at: mission.updatedAt, text: missionNote(mission, 'ended'), source: 'code' as const })),
    ])
    knownMissions = next
  })

  // The owner starts to speak, or queues a message behind the turn. Either one makes the turn stale.
  watch(() => ownerSpeaking.value || chat.pendingQueuedSendCount > 0, (ownerFirst) => {
    if (ownerFirst)
      dropRunningTurn()
  })

  // The owner starts to type. A chat input writes a new end time for typing, so the first write of a pause starts it.
  watch(() => ownerTyping.typingUntil, (typingUntil) => {
    if (isOwnerTyping(typingUntil, Date.now()))
      dropRunningTurn()
  })

  /**
   * Starts the ticker while this renderer leads. Later calls do nothing.
   *
   * @param syncedPinia The synced Pinia runtime. Only its leader runs the policy.
   * @param source Where the app reads whether the owner is at the device. Without it, no welcome back comes.
   */
  function initialize(syncedPinia: SyncedPiniaRuntime, source?: OwnerPresenceSource) {
    if (leadership)
      return
    leadership = syncedPinia
    presenceSource = source
    stopAwayListener = source?.onAway?.(() => {
      presence.value = markAway(presence.value, Date.now())
    })
    initiative.supported = true
    stopLeadershipListener = syncedPinia.onLeadershipChange((isLeader) => {
      if (isLeader) {
        ticker.start()
      }
      else {
        ticker.stop()
        state.value = undefined
      }
    })
    if (syncedPinia.isLeader())
      ticker.start()
  }

  function dispose() {
    stopScreenEvents()
    stopTargetClosed()
    stopLeadershipListener?.()
    stopLeadershipListener = undefined
    stopAwayListener?.()
    stopAwayListener = undefined
    presenceSource = undefined
    ticker.stop()
    leadership = undefined
    state.value = undefined
  }

  onScopeDispose(dispose)

  return {
    /** The policy state, for an inspector. It is read only. */
    state: readonly(state),
    initialize,
    dispose,
  }
})
