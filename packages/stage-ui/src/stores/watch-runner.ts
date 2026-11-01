import type { Conversation, WatchMission } from '@proj-airi/core-agent'
import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import type { CapturedFrame } from '../libs/perception/frame-ring'

import { errorMessageFrom } from '@moeru/std'
import { encodeBase64 } from '@moeru/std/base64'
import { deliverReminder, regionBox, shouldCheckWatch, WATCH_LIMITS, watchCheckInstruction, watchNoticeText } from '@proj-airi/core-agent'
import { regionDiff } from '@proj-airi/stage-shared/perception'
import { rawTool } from '@xsai/tool'
import { defineStore } from 'pinia'
import { boolean, description, maxLength, pipe, safeParse, strictObject, string } from 'valibot'
import { onScopeDispose } from 'vue'
import { useI18n } from 'vue-i18n'
import { toJsonSchema } from 'xsschema'

import { useTextGeneration } from '../composables/text-generation'
import { cropImage } from '../libs/perception/encode-frame'
import { FRAME_LIMITS } from '../libs/perception/frame-ring'
import { Ticker } from '../workers/ticker'
import { useChatStore } from './chat'
import { useChatSessionStore } from './chat/session-store'
import { useMissionsStore } from './missions'
import { useAiriCardStore } from './modules/airi-card'
import { usePerceptionStore } from './perception'
import { usePerceptionRunnerStore } from './perception-runner'
import { useTimelineStore } from './timeline'

/** The runner looks at the watch once each second. The check rules decide whether a check goes out. */
const TICK_INTERVAL_MS = 1_000
/** A check that takes longer than this is given up. The next one tries again. */
const CHECK_TIMEOUT_MS = 60_000

const reportParameters = strictObject({
  holds: pipe(boolean(), description('True only when the image clearly shows the condition.')),
  seen: pipe(string(), maxLength(200), description('What you see that matters for the condition, in a few words.')),
})

/**
 * Checks the running watch on the renderer leader, and tells the owner once when its condition holds.
 *
 * - A check turn is one model call outside the conversation. It gets a small crop of the watched region and answers
 *   with the `report_watch` tool. The call stops after the answer, so a check costs one call.
 * - A check comes on a change of the region, or on a slow timer, and only while the app of the watch is in front and no
 *   excluded window is. Each check counts one image in the image budget, and it waits while the budget is empty.
 * - A "yes" sends a `mustSpeak` notice to the conversation of the watch, with the fixed text as the last fallback. The
 *   watch then ends as done, and the timeline notes it.
 *
 * Use when:
 * - An app starts its renderer. Call `initialize` once with the synced Pinia runtime.
 */
export const useWatchRunnerStore = defineStore('watch-runner', () => {
  const missions = useMissionsStore()
  const perception = usePerceptionStore()
  const perceptionRunner = usePerceptionRunnerStore()
  const chat = useChatStore()
  const chatSession = useChatSessionStore()
  const cardStore = useAiriCardStore()
  const timeline = useTimelineStore()
  const { generateText } = useTextGeneration()
  const { t } = useI18n()

  const ticker = new Ticker(TICK_INTERVAL_MS, () => void tick())
  let leadership: SyncedPiniaRuntime | undefined
  let stopLeadershipListener: (() => void) | undefined
  let checking = false
  /** The thumbnail of the last check, and the watch it belongs to. A change of its region starts the next check. */
  let lastChecked: { watchId: string, thumbnail: Uint8Array } | undefined

  /** The conversation that gets the notice: the one of the watch, or the open one when the owner deleted it. */
  function targetSession(watch: WatchMission) {
    return chatSession.sessionMetas[watch.sessionId] ? watch.sessionId : chatSession.activeSessionId
  }

  async function tick() {
    if (!leadership?.isLeader() || !missions.enabled || checking)
      return
    const now = Date.now()
    const watch = missions.watchAt(now)
    if (!watch || !perceptionRunner.running() || perceptionRunner.excludedNow())
      return
    // The watch looks only while its app is in front. The web cannot tell the app, so its share counts as the app.
    const app = perceptionRunner.foregroundApp()
    if (app !== undefined && !app.toLowerCase().includes(watch.values.app.toLowerCase()))
      return
    const frame = perceptionRunner.frames().at(-1)
    if (!frame)
      return
    const before = lastChecked?.watchId === watch.id ? lastChecked.thumbnail : undefined
    const change = before ? regionDiff(before, frame.thumbnail, FRAME_LIMITS.thumbnailWidth, FRAME_LIMITS.thumbnailHeight, regionBox(watch.values.region)) : 1
    if (!shouldCheckWatch({ now, ...(watch.values.lastCheckAt !== undefined ? { lastCheckAt: watch.values.lastCheckAt } : {}), regionChange: change }))
      return
    if (perception.budgetAt(now, Boolean(missions.commentaryAt(now))).remaining <= 0)
      return
    checking = true
    try {
      await check(watch, frame, now)
    }
    catch (error) {
      console.warn('[watch] Failed to check the watch:', errorMessageFrom(error))
    }
    finally {
      checking = false
    }
  }

  /** Sends one check turn. Resolves to the answer of the model, or `undefined` without one. */
  async function askModel(watch: WatchMission, crop: Blob) {
    const characterId = chatSession.sessionMetas[watch.sessionId]?.characterId ?? cardStore.activeCardId
    const { provider, model } = cardStore.getModules(characterId).consciousness
    if (!provider || !model)
      return undefined
    let answer: { holds: boolean, seen: string } | undefined
    const stop = new AbortController()
    const report = rawTool({
      name: 'report_watch',
      description: 'Report whether the condition of the watch holds in the image.',
      parameters: await toJsonSchema(reportParameters),
      execute: async (input) => {
        const parsed = safeParse(reportParameters, input)
        if (!parsed.success)
          return 'Give holds as true or false, and seen as a short text.'
        answer = parsed.output
        // The answer is all that the check needs, so the turn stops before the model writes on.
        queueMicrotask(() => stop.abort('The watch got its answer.'))
        return 'Recorded.'
      },
    })
    const conversation: Conversation = {
      turns: [
        { type: 'system', id: 'watch-check-instruction', authority: 'system', content: [{ type: 'text', text: watchCheckInstruction(watch.values.condition) }] },
        {
          type: 'user',
          id: 'watch-check-image',
          content: [
            { type: 'image', url: `data:image/jpeg;base64,${encodeBase64(new Uint8Array(await crop.arrayBuffer()))}` },
            { type: 'text', text: `The ${watch.values.region} region of ${watch.values.app} now.` },
          ],
        },
      ],
    }
    try {
      await generateText({ providerId: provider, model }, 'watch')(conversation, AbortSignal.any([stop.signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]), [report])
    }
    catch (error) {
      if (!answer)
        throw error
    }
    return answer
  }

  async function check(watch: WatchMission, frame: CapturedFrame, now: number) {
    lastChecked = { watchId: watch.id, thumbnail: frame.thumbnail }
    const crop = await cropImage(frame.image, regionBox(watch.values.region), WATCH_LIMITS.cropLongSide)
    perception.recordImages(1, now)
    const answer = await askModel(watch, crop)
    await missions.recordCheck(watch.id, now, answer?.seen ?? 'no answer')
    if (!answer?.holds)
      return

    const sessionId = targetSession(watch)
    await deliverReminder(
      notice => chat.notifyConversation(sessionId, { ...notice, mustSpeak: true }),
      watchNoticeText(watch, answer.seen),
      t('stage.missions.fixed-watch', { condition: watch.values.condition }),
      'mission:watch',
    )
    await missions.stop(watch.id, 'condition')
    await timeline.addNotes(sessionId, [{ at: Date.now(), text: `Watch held: ${watch.values.condition}`, source: 'code' }])
  }

  /** Starts the ticker while this renderer leads. Later calls do nothing. */
  function initialize(syncedPinia: SyncedPiniaRuntime) {
    if (leadership)
      return
    leadership = syncedPinia
    stopLeadershipListener = syncedPinia.onLeadershipChange((isLeader) => {
      if (isLeader)
        ticker.start()
      else
        ticker.stop()
    })
    if (syncedPinia.isLeader())
      ticker.start()
  }

  function dispose() {
    stopLeadershipListener?.()
    stopLeadershipListener = undefined
    ticker.stop()
    leadership = undefined
  }

  onScopeDispose(dispose)

  return {
    initialize,
    dispose,
  }
})
