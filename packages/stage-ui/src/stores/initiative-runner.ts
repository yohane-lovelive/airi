import type { InitiativeDecision, InitiativeEvent, InitiativeHost, InitiativeState } from '@proj-airi/core-agent'
import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import { errorMessageFrom } from '@moeru/std'
import { createInitiativeState, decideInitiative, initiativeNoticeText, initiativeTimeFrom, observeInitiative, resolveInitiativeOptions } from '@proj-airi/core-agent'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { computed, onScopeDispose, readonly, shallowRef, watch } from 'vue'

import { INITIATIVE_SOURCE, initiativeConversationFacts, initiativeEventOf } from '../libs/initiative/conversation'
import { isOwnerTyping } from '../libs/initiative/typing'
import { Ticker } from '../workers/ticker'
import { useSpeakingStore } from './audio'
import { useChatStore } from './chat'
import { useChatSessionStore } from './chat/session-store'
import { useInitiativeStore } from './initiative'
import { useIntentionsStore } from './intentions'
import { useOwnerTypingStore } from './owner-typing'
import { useVoiceStore } from './voice'
import { useVoiceMessagesStore } from './voice-messages'

/** The policy decides once each second. The drive changes slowly, so a finer check adds nothing. */
const TICK_INTERVAL_MS = 1_000

/**
 * Runs autonomous speech on the renderer leader: the character starts to talk without an owner message.
 *
 * State model:
 * - The policy state of `@proj-airi/core-agent` lives here, in memory only. A restart or a new leader starts rested and
 *   not bored. Turning the feature off drops the state.
 * - Each tick asks `decideInitiative`. On a turn, a transient notice goes to the conversation that the owner has open.
 *   History keeps the reply only, so silent turns leave no trace.
 * - Stored messages of that conversation feed the policy: an owner message, and a reply that no autonomous turn started.
 * - The open intentions add drive, and the situation block lists them. The owner's temporary changes, for example a
 *   quiet time, change the options at each tick.
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
  const { activeSessionId } = storeToRefs(chatSession)

  /** The policy state. Undefined while the feature is off or this renderer does not lead. */
  const state = shallowRef<InitiativeState>()
  /** The autonomous turn in flight. The policy holds one turn at most. */
  let running: { sessionId: string, turnId: string, dropped: boolean } | undefined
  const ticker = new Ticker(TICK_INTERVAL_MS, tick)
  let leadership: SyncedPiniaRuntime | undefined
  let stopLeadershipListener: (() => void) | undefined

  const ownerSpeaking = computed(() => voiceMessages.isRecording || voice.state?.phase === 'capturing')
  const activeMessages = computed(() => chatSession.getSessionMessagesIfLoaded(activeSessionId.value))

  /** The options at `now`. The owner's temporary changes end on their own, so each call reads them again. */
  function optionsAt(now: number) {
    return resolveInitiativeOptions(initiative.settingsAt(now))
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

  async function runTurn(decision: Extract<InitiativeDecision, { kind: 'turn' }>, sessionId: string) {
    const date = new Date()
    const time = initiativeTimeFrom(date)
    const facts = initiativeConversationFacts(chatSession.getSessionMessages(sessionId))
    const text = initiativeNoticeText({
      mode: state.value?.mode ?? 'idle',
      trigger: decision.trigger,
      ...(decision.speechType ? { speechType: decision.speechType } : {}),
      now: time.now,
      localMinutes: time.localMinutes,
      ...facts,
      intentions: intentions.openAt(time.now),
    })
    const turn = { sessionId, turnId: nanoid(), dropped: false }
    running = turn
    let outcome: 'spoke' | 'silent' | 'dropped' | 'failed' = 'failed'
    try {
      const result = await chat.notifyConversation(sessionId, { source: INITIATIVE_SOURCE, text, transient: true }, turn.turnId)
      outcome = turn.dropped ? 'dropped' : result === 'spoke' ? 'spoke' : result === 'failed' ? 'failed' : 'silent'
    }
    catch (error) {
      console.warn('[initiative] Failed to run an autonomous turn:', errorMessageFrom(error))
    }
    finally {
      running = undefined
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
    const { state: next, decision } = decideInitiative(state.value ?? createInitiativeState(time), host(time.now), time, Math.random, optionsAt(time.now))
    state.value = next
    if (decision.kind === 'turn')
      void runTurn(decision, sessionId)
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
    if (event.type === 'owner-message')
      dropRunningTurn()
    observe(event)
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

  /** Starts the ticker while this renderer leads. Later calls do nothing. */
  function initialize(syncedPinia: SyncedPiniaRuntime) {
    if (leadership)
      return
    leadership = syncedPinia
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
    stopLeadershipListener?.()
    stopLeadershipListener = undefined
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
