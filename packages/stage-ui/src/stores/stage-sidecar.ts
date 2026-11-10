import type { GestureClipSource } from '@proj-airi/stage-shared/body-motion'
import type { CharacterAttentionTarget, CharacterFrame } from '@proj-airi/stage-shared/stage-sidecar'

import { defineStore } from 'pinia'

/**
 * Where the signals of the character go when a sidecar draws it.
 *
 * `stage-ui` cannot import the IPC contracts of an app, so the desktop app registers this output. The web app registers
 * nothing, because it has no sidecar.
 */
export interface StageSidecarOutput {
  /** @param holdMs How long the expression stays. Without a value, the sidecar uses its default. */
  setExpression: (name: string, intensity: number, holdMs?: number) => void
  /** @returns whether the clip reached the sidecar. */
  playGesture: (source: GestureClipSource) => Promise<boolean>
  sendFrame: (frame: CharacterFrame) => void
  /** Called only when the target changes. A new sidecar has no target, so the output sends the last one again. */
  setAttention: (target: CharacterAttentionTarget) => void
}

/**
 * Holds the one output of this window. The output is not state: it is a set of functions, so it stays out of the store
 * state and out of any synchronization. Without an output, each call does nothing.
 */
export const useStageSidecarStore = defineStore('stage-sidecar', () => {
  let output: StageSidecarOutput | undefined

  function setOutput(next: StageSidecarOutput | undefined) {
    output = next
  }

  return {
    setOutput,
    setExpression: (name: string, intensity: number, holdMs?: number) => output?.setExpression(name, intensity, holdMs),
    playGesture: async (source: GestureClipSource) => await output?.playGesture(source) ?? false,
    sendFrame: (frame: CharacterFrame) => output?.sendFrame(frame),
    setAttention: (target: CharacterAttentionTarget) => output?.setAttention(target),
  }
})
