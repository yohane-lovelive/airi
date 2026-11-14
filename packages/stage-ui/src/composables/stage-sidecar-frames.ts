import type { Profile, WLipSyncAudioNode, WLipSyncFrame } from '@proj-airi/model-driver-lipsync/shared/wlipsync'
import type { SpeechConnector } from '@proj-airi/stage-shared/body-motion'
import type { CharacterFrame } from '@proj-airi/stage-shared/stage-sidecar'
import type { MaybeRefOrGetter } from 'vue'

import { createWLipSyncNode } from '@proj-airi/model-driver-lipsync/runtime/wlipsync'
import { createWLipSyncVowelDriver, wlipsyncProfile } from '@proj-airi/model-driver-lipsync/shared/wlipsync'
import { SpeechLevelMeter } from '@proj-airi/stage-shared/body-motion'
import { onScopeDispose, toValue, watch } from 'vue'

import { CharacterFrameStream } from '../libs/character-frame-stream'

/** The vowel driver closes the mouth with its usual smoothing when it reads this frame. */
const SILENT_FRAME: WLipSyncFrame = Object.freeze({ volume: 0, weights: Object.freeze({}) })

/**
 * Streams the mouth and the procedural layer to a sidecar while `active` is true.
 *
 * The analysis listens through `connectSpeech`, beside the playback. So the volume of the owner does not change the
 * mouth.
 * While the lip sync node loads, the mouth stays closed and the body still moves.
 *
 * The mouth follows the node only while `isSpeaking` is true, because the node keeps its last values when its input has
 * no audio. Without this rule, the mouth stays open after the speech ends. The Live2D path of `Stage.vue` has the same
 * rule.
 *
 * The audio connections exist only while `active` is true. A stage that draws by itself pays nothing for this.
 */
export function useStageSidecarFrames(params: {
  active: MaybeRefOrGetter<boolean>
  audioContext: AudioContext
  /** Connects a node to the played speech and returns the disconnection. */
  connectSpeech: SpeechConnector
  isSpeaking: () => boolean
  isThinking: () => boolean
  isBodyMotionEnabled: () => boolean
  send: (frame: CharacterFrame) => void
}) {
  const vowelDriver = createWLipSyncVowelDriver()
  const meter = new SpeechLevelMeter(params.audioContext)
  let lipSyncNode: WLipSyncAudioNode | undefined

  const stream = new CharacterFrameStream({
    readMouth: delta => vowelDriver.update(lipSyncNode && params.isSpeaking() ? lipSyncNode : SILENT_FRAME, delta),
    readSpeechLevel: () => meter.read(),
    isThinking: params.isThinking,
    isBodyMotionEnabled: params.isBodyMotionEnabled,
    send: params.send,
  })

  watch(() => toValue(params.active), (active, _, onCleanup) => {
    if (!active)
      return

    let cancelled = false
    let disconnectLipSync: (() => void) | undefined
    meter.listen(params.connectSpeech)
    stream.start()

    void createWLipSyncNode(params.audioContext, wlipsyncProfile as Profile)
      .then((node) => {
        if (cancelled) {
          node.disconnect()
          return
        }
        disconnectLipSync = params.connectSpeech(node)
        lipSyncNode = node
      })
      .catch(error => console.error('[Stage] Failed to create the lip sync node for the sidecar.', error))

    onCleanup(() => {
      cancelled = true
      stream.stop()
      meter.listen(undefined)
      vowelDriver.reset()
      if (lipSyncNode) {
        disconnectLipSync?.()
        lipSyncNode.disconnect()
        lipSyncNode = undefined
      }
    })
  }, { immediate: true })

  onScopeDispose(() => {
    stream.stop()
    meter.dispose()
  })
}
