/** The parts of the body that a gesture can take from the idle clip. Hips, legs, and morphs always stay with the idle. */
export const GESTURE_GROUPS = ['head', 'torso', 'leftArm', 'rightArm'] as const

export type GestureGroup = typeof GESTURE_GROUPS[number]

/** The group of a VRM humanoid bone, or undefined for a bone that stays with the idle, for example `hips` or an eye. */
export function gestureGroupOfHumanBone(name: string): GestureGroup | undefined {
  if (name === 'neck' || name === 'head')
    return 'head'
  if (name === 'spine' || name === 'chest' || name === 'upperChest')
    return 'torso'
  if (/UpperLeg|LowerLeg|Foot|Toes|Eye/.test(name))
    return undefined
  if (name.startsWith('left'))
    return 'leftArm'
  if (name.startsWith('right'))
    return 'rightArm'
  return undefined
}

/** The part of a three.js `AnimationAction` that the layer uses, so this package needs no three.js dependency. */
export interface GestureLayerAction {
  enabled: boolean
  reset: () => unknown
  play: () => unknown
  stop: () => unknown
  setEffectiveWeight: (weight: number) => unknown
  fadeIn: (seconds: number) => unknown
  fadeOut: (seconds: number) => unknown
}

/** What the layer needs from the animation runtime of a renderer. */
export interface GestureLayerAdapter<Clip, Action extends GestureLayerAction> {
  trackNames: (clip: Clip) => string[]
  duration: (clip: Clip) => number
  /** A clip with the tracks of `clip` that `keep` accepts. */
  subclip: (clip: Clip, name: string, keep: (trackName: string) => boolean) => Clip
  /** The group of the bone that a track moves, or undefined for a track that stays with the idle. */
  groupOfTrack: (trackName: string) => GestureGroup | undefined
  /** An action of the mixer that plays `clip` in a loop, or once and then holds its last frame. */
  action: (clip: Clip, loop: 'repeat' | 'once') => Action
}

type IdlePart = GestureGroup | 'base'

interface PlayingGesture<Action> {
  action: Action
  groups: Set<GestureGroup>
  duration: number
  elapsed: number
  crossfade: number
  released: boolean
}

/** The default cross-fade of a gesture, in seconds. */
export const GESTURE_CROSSFADE = 0.4

/**
 * Plays gestures over an idle clip, part by part.
 *
 * A three.js mixer has no bone mask. So the layer splits the idle clip into one action for each {@link GestureGroup}
 * and one for the rest. The actions start together, so they look like the one idle clip. A gesture fades out only the
 * idle actions of the parts that it moves, and fades them back when it ends. A nod then keeps the idle arms and legs.
 *
 * Use when:
 * - A VRM or MMD renderer plays an `ACT` gesture while its idle clip keeps moving the rest of the body.
 */
export class GestureLayer<Clip, Action extends GestureLayerAction> {
  private readonly idle = new Map<IdlePart, Action>()
  private gesture: PlayingGesture<Action> | undefined

  constructor(private readonly adapter: GestureLayerAdapter<Clip, Action>) {}

  /** Whether a gesture plays now, including its fade back to the idle. */
  get playing() {
    return !!this.gesture
  }

  /** Replaces the idle clip. The old idle fades out while the new one fades in. Without a clip, the idle stops. */
  setIdle(clip: Clip | undefined, crossfade = GESTURE_CROSSFADE) {
    this.stopGesture(crossfade)
    for (const action of this.idle.values()) {
      if (crossfade > 0)
        action.fadeOut(crossfade)
      else
        action.stop()
    }
    this.idle.clear()
    if (!clip)
      return

    for (const [part, partClip] of this.split(clip))
      this.idle.set(part, this.adapter.action(partClip, 'repeat'))
    this.fadeIdleIn(crossfade)
  }

  /** Fades the whole idle out, for a motion of the whole body. A gesture that plays stops too. */
  fadeIdleOut(crossfade = GESTURE_CROSSFADE) {
    this.stopGesture(crossfade)
    for (const action of this.idle.values())
      action.fadeOut(crossfade)
  }

  /** Starts the whole idle again from its start, after a motion of the whole body. */
  fadeIdleIn(crossfade = GESTURE_CROSSFADE) {
    for (const action of this.idle.values()) {
      action.reset()
      action.setEffectiveWeight(1)
      if (crossfade > 0)
        action.fadeIn(crossfade)
      action.play()
    }
  }

  /**
   * Plays `clip` once over the parts that its tracks move.
   *
   * @returns false when the clip moves no part that a gesture can take.
   */
  playGesture(clip: Clip, crossfade = GESTURE_CROSSFADE): boolean {
    const groups = new Set(this.adapter.trackNames(clip).map(this.adapter.groupOfTrack).filter(group => group !== undefined))
    if (groups.size === 0)
      return false
    this.stopGesture(crossfade)

    for (const group of groups)
      this.idle.get(group)?.fadeOut(crossfade)
    const action = this.adapter.action(clip, 'once')
    action.reset()
    action.setEffectiveWeight(1)
    action.fadeIn(crossfade)
    action.play()
    this.gesture = { action, groups, duration: this.adapter.duration(clip), elapsed: 0, crossfade, released: false }
    return true
  }

  /** Fades the gesture out and its parts of the idle back in. */
  stopGesture(crossfade = GESTURE_CROSSFADE) {
    const gesture = this.gesture
    if (!gesture)
      return
    this.release(gesture, crossfade)
    gesture.action.stop()
    this.gesture = undefined
  }

  /** Advances the gesture. Call it once each frame with the delta of the mixer. */
  update(delta: number) {
    const gesture = this.gesture
    if (!gesture)
      return
    gesture.elapsed += delta
    // The fade back starts before the end, so the last frame of the gesture is the middle of the fade.
    if (!gesture.released && gesture.elapsed >= gesture.duration - gesture.crossfade / 2)
      this.release(gesture, gesture.crossfade)
    if (gesture.elapsed >= gesture.duration + gesture.crossfade) {
      gesture.action.stop()
      this.gesture = undefined
    }
  }

  dispose() {
    this.gesture?.action.stop()
    this.gesture = undefined
    for (const action of this.idle.values())
      action.stop()
    this.idle.clear()
  }

  private release(gesture: PlayingGesture<Action>, crossfade: number) {
    if (gesture.released)
      return
    gesture.released = true
    gesture.action.fadeOut(crossfade)
    for (const group of gesture.groups) {
      const action = this.idle.get(group)
      if (!action)
        continue
      // A finished fade-out disables the action. A reset would also move it to the start, out of step with the rest.
      action.enabled = true
      action.fadeIn(crossfade)
    }
  }

  /** The idle clip in parts. A clip that moves no gesture part stays one clip. */
  private split(clip: Clip): Map<IdlePart, Clip> {
    const names = this.adapter.trackNames(clip)
    const groups = new Set(names.map(this.adapter.groupOfTrack).filter(group => group !== undefined))
    if (groups.size === 0)
      return new Map([['base', clip]])
    const parts = new Map<IdlePart, Clip>()
    for (const group of groups)
      parts.set(group, this.adapter.subclip(clip, `${group}`, name => this.adapter.groupOfTrack(name) === group))
    if (names.some(name => this.adapter.groupOfTrack(name) === undefined))
      parts.set('base', this.adapter.subclip(clip, 'base', name => this.adapter.groupOfTrack(name) === undefined))
    return parts
  }
}
