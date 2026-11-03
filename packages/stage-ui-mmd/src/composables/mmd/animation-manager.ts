import type { MMD } from '@moeru/three-mmd'
import type { AnimationAction, AnimationClip } from 'three'

import { GestureLayer } from '@proj-airi/stage-shared/body-motion'
import { AnimationMixer, AnimationClip as Clip, LoopOnce, LoopRepeat, Vector3 } from 'three'

import { ensureAmmo } from '../../utils/ammo'
import { mmdGestureGroupOfTrack } from '../../utils/mmd-gestures'

const DEFAULT_CROSSFADE = 0.4

export interface MMDAnimationManagerOptions {
  /**
   * Initial physics enablement. Ammo is still installed so physics can be
   * enabled later without rebuilding the model runtime.
   *
   * @default true
   */
  physicsEnabled?: boolean
}

export interface PlayActionOptions {
  /**
   * Loop the action instead of reverting to idle when it finishes.
   *
   * @default false
   */
  loop?: boolean
  /**
   * Cross-fade duration in seconds.
   *
   * @default 0.4
   */
  crossfade?: number
}

/**
 * Owns a model's animation mixer, imported VMD catalog, solver feature gates,
 * and lazily installed Ammo runtime.
 *
 * `update(delta)` must run once per frame before AIRI-owned expression,
 * lip-sync, blink, and gaze overrides. Disposal stops actions before ending
 * the MMD runtime so no frame can observe a partially torn-down model.
 */
export function createMMDAnimationManager(mmd: MMD, options: MMDAnimationManagerOptions = {}) {
  const mixer = new AnimationMixer(mmd.mesh)
  const registry = new Map<string, AnimationClip>()
  const finishListeners = new Map<AnimationAction, (event: { action: AnimationAction }) => void>()
  /** The parts of each split clip, so a clip that comes back reuses its actions. */
  const subclips = new WeakMap<AnimationClip, Map<string, AnimationClip>>()

  // The idle plays in parts, so a gesture can take the head or an arm while the rest keeps the idle.
  const layer = new GestureLayer<AnimationClip, AnimationAction>({
    trackNames: clip => clip.tracks.map(track => track.name),
    duration: clip => clip.duration,
    subclip: (clip, name, keep) => {
      let parts = subclips.get(clip)
      if (!parts) {
        parts = new Map()
        subclips.set(clip, parts)
      }
      let part = parts.get(name)
      if (!part) {
        part = new Clip(`${clip.name}:${name}`, clip.duration, clip.tracks.filter(track => keep(track.name)))
        parts.set(name, part)
      }
      return part
    },
    groupOfTrack: mmdGestureGroupOfTrack,
    action: (clip, loop) => {
      const action = mixer.clipAction(clip)
      action.setLoop(loop === 'repeat' ? LoopRepeat : LoopOnce, loop === 'repeat' ? Number.POSITIVE_INFINITY : 1)
      action.clampWhenFinished = loop === 'once'
      return action
    },
  })

  let idleClip: AnimationClip | undefined
  /** A motion of the whole body that plays instead of the idle. */
  let oneShot: AnimationAction | undefined
  let initialized = false
  let disposed = false
  let initialization: Promise<void> | undefined
  let physicsEnabled = options.physicsEnabled ?? true
  let ikEnabled = true
  let grantEnabled = true
  let gravity: number | undefined

  function removeFinishListener(action: AnimationAction): void {
    const listener = finishListeners.get(action)
    if (!listener)
      return
    mixer.removeEventListener('finished', listener)
    finishListeners.delete(action)
  }

  function revertToIdleOnFinish(action: AnimationAction): void {
    removeFinishListener(action)
    const onFinished = (event: { action: AnimationAction }) => {
      if (event.action !== action)
        return
      removeFinishListener(action)
      playIdle()
    }
    finishListeners.set(action, onFinished)
    mixer.addEventListener('finished', onFinished)
  }

  /**
   * Installs the lazy Ammo backend and optionally starts an initial idle clip.
   * Concurrent calls share one initialization; disposal while Ammo loads
   * prevents the completed promise from reviving the manager.
   */
  async function init(idle?: AnimationClip): Promise<void> {
    if (initialized || disposed)
      return
    if (initialization)
      return initialization

    initialization = (async () => {
      const createPhysics = await ensureAmmo()
      if (disposed)
        return

      mmd.setPhysics(createPhysics)
      if (gravity !== undefined)
        mmd.physics?.setGravity?.(new Vector3(0, -gravity, 0))

      if (idle) {
        idleClip = idle
        layer.setIdle(idle, 0)
      }
      initialized = true
    })()

    return initialization
  }

  /** Registers a VMD-derived clip under a name for later playback. */
  function registerClip(name: string, clip: AnimationClip): void {
    registry.set(name, clip)
  }

  /** Names of all registered motions, for settings UIs and action mapping. */
  function availableClips(): string[] {
    return Array.from(registry.keys())
  }

  /** Cross-fades back to the persistent idle loop. */
  function playIdle(crossfade = DEFAULT_CROSSFADE): void {
    // With no configured idle, fade the active motion out so the skeleton
    // returns to its rest pose instead of clamping on the final keyframe.
    if (oneShot) {
      removeFinishListener(oneShot)
      oneShot.fadeOut(crossfade)
      oneShot = undefined
    }
    if (idleClip)
      layer.fadeIdleIn(crossfade)
  }

  /**
   * Plays a registered motion and cross-fades from the current action.
   * One-shots return to idle; looping actions remain active until replaced.
   *
   * @returns `false` when no clip is registered under `name`.
   */
  function playAction(name: string, actionOptions: PlayActionOptions = {}): boolean {
    const clip = registry.get(name)
    if (!clip) {
      console.warn(`[mmd] playAction skipped: "${name}" is not registered`)
      return false
    }
    playClip(clip, actionOptions)
    return true
  }

  /** Plays a motion of the whole body that the owner did not register, for example an imported `.vrma` clip. */
  function playClip(clip: AnimationClip, actionOptions: PlayActionOptions = {}): void {
    const loop = actionOptions.loop ?? false
    const crossfade = actionOptions.crossfade ?? DEFAULT_CROSSFADE
    const action = mixer.clipAction(clip)
    action.reset()
    action.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Number.POSITIVE_INFINITY : 1)
    action.clampWhenFinished = !loop
    action.setEffectiveWeight(1)
    action.fadeIn(crossfade).play()

    if (oneShot && oneShot !== action) {
      removeFinishListener(oneShot)
      oneShot.fadeOut(crossfade)
    }
    else if (!oneShot) {
      layer.fadeIdleOut(crossfade)
    }
    oneShot = action

    if (loop)
      removeFinishListener(action)
    else
      revertToIdleOnFinish(action)
  }

  /**
   * Makes a registered motion the looping base that one-shots return to.
   *
   * @returns `false` when no clip is registered under `name`.
   */
  function setIdleMotion(name: string, crossfade = DEFAULT_CROSSFADE): boolean {
    const clip = registry.get(name)
    if (!clip) {
      console.warn(`[mmd] setIdleMotion skipped: "${name}" is not registered`)
      return false
    }

    if (oneShot) {
      removeFinishListener(oneShot)
      oneShot.fadeOut(crossfade)
      oneShot = undefined
    }
    idleClip = clip
    layer.setIdle(clip, crossfade)
    return true
  }

  /**
   * Plays a gesture once over the parts of the body that it moves, while the idle keeps the rest. A motion of the
   * whole body wins, so a gesture waits for none and is skipped while one plays.
   *
   * @returns `false` when a motion of the whole body plays, or when the clip moves no part that a gesture can take.
   */
  function playGesture(clip: AnimationClip, crossfade = DEFAULT_CROSSFADE): boolean {
    if (oneShot)
      return false
    return layer.playGesture(clip, crossfade)
  }

  function setPhysicsEnabled(enabled: boolean): void {
    physicsEnabled = enabled
  }

  /** Sets physics gravity to `(0, -magnitude, 0)`, including during init. */
  function setGravity(magnitude: number): void {
    gravity = magnitude
    mmd.physics?.setGravity?.(new Vector3(0, -magnitude, 0))
  }

  function setIKEnabled(enabled: boolean): void {
    ikEnabled = enabled
  }

  function setGrantEnabled(enabled: boolean): void {
    grantEnabled = enabled
  }

  function update(delta: number): void {
    if (!initialized || disposed)
      return
    layer.update(delta)
    mmd.updateWithMixer(delta, mixer, {
      grant: grantEnabled,
      ik: ikEnabled,
      physics: physicsEnabled,
    })
  }

  function dispose(): void {
    if (disposed)
      return
    disposed = true

    for (const listener of finishListeners.values())
      mixer.removeEventListener('finished', listener)
    finishListeners.clear()
    layer.dispose()
    mixer.stopAllAction()
    mixer.uncacheRoot(mmd.mesh)
    mmd.dispose()
    registry.clear()
    idleClip = undefined
    oneShot = undefined
    initialized = false
  }

  return {
    init,
    registerClip,
    availableClips,
    playIdle,
    playAction,
    playClip,
    playGesture,
    setIdleMotion,
    setPhysicsEnabled,
    setGravity,
    setIKEnabled,
    setGrantEnabled,
    update,
    dispose,
  }
}

export type MMDAnimationManager = ReturnType<typeof createMMDAnimationManager>
