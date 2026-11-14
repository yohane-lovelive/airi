import type { GestureLayerAction, GestureLayerAdapter } from './gesture-layer'

import { describe, expect, it } from 'vitest'

import { gestureGroupOfHumanBone, GestureLayer } from './gesture-layer'

interface FakeClip {
  name: string
  tracks: string[]
  duration: number
}

/** Records the weight that each fade aims for, which is the weight that the mixer reaches after the fade. */
class FakeAction implements GestureLayerAction {
  enabled = true
  playing = false
  weight = 0
  resets = 0
  constructor(readonly clip: FakeClip, readonly loop: 'repeat' | 'once') {}
  reset() {
    this.resets++
    this.enabled = true
  }

  play() {
    this.playing = true
  }

  stop() {
    this.playing = false
  }

  setEffectiveWeight(weight: number) {
    this.weight = weight
  }

  fadeIn() {
    this.weight = 1
  }

  fadeOut() {
    this.weight = 0
    // A finished fade-out disables the action, as in three.js.
    this.enabled = false
  }
}

function createLayer() {
  const actions: FakeAction[] = []
  const adapter: GestureLayerAdapter<FakeClip, FakeAction> = {
    trackNames: clip => clip.tracks,
    duration: clip => clip.duration,
    subclip: (clip, name, keep) => ({ name: `${clip.name}:${name}`, tracks: clip.tracks.filter(keep), duration: clip.duration }),
    groupOfTrack: track => gestureGroupOfHumanBone(track.split('.')[0]),
    action: (clip, loop) => {
      const action = new FakeAction(clip, loop)
      actions.push(action)
      return action
    },
  }
  const layer = new GestureLayer(adapter)
  const idleOf = (name: string) => actions.find(action => action.clip.name === `idle:${name}`)!
  return { layer, actions, idleOf }
}

const idle: FakeClip = { name: 'idle', tracks: ['hips.quaternion', 'head.quaternion', 'leftUpperArm.quaternion', 'rightUpperArm.quaternion', 'spine.quaternion'], duration: 4 }
const nod: FakeClip = { name: 'nod', tracks: ['neck.quaternion', 'head.quaternion'], duration: 1 }
const wave: FakeClip = { name: 'wave', tracks: ['rightUpperArm.quaternion', 'rightLowerArm.quaternion'], duration: 2 }

describe('gestureGroupOfHumanBone', () => {
  it('groups the head, the torso, and each arm with its fingers, and leaves the legs and eyes with the idle', () => {
    expect(['neck', 'head', 'chest', 'leftShoulder', 'rightIndexProximal', 'hips', 'leftUpperLeg', 'leftEye'].map(gestureGroupOfHumanBone))
      .toEqual(['head', 'head', 'torso', 'leftArm', 'rightArm', undefined, undefined, undefined])
  })
})

describe('gestureLayer', () => {
  it('plays the idle in parts that start together', () => {
    const { layer, actions } = createLayer()

    layer.setIdle(idle, 0)

    expect(actions.map(action => action.clip.name).sort()).toEqual(['idle:base', 'idle:head', 'idle:leftArm', 'idle:rightArm', 'idle:torso'])
    expect(actions.every(action => action.playing && action.weight === 1 && action.resets === 1)).toBe(true)
  })

  it('keeps an idle that moves no gesture part as one clip', () => {
    const { layer, actions } = createLayer()

    layer.setIdle({ name: 'legs', tracks: ['hips.position'], duration: 1 }, 0)

    expect(actions.map(action => action.clip.name)).toEqual(['legs'])
  })

  it('takes only the parts that a gesture moves, and gives them back without a restart when it ends', () => {
    const { layer, idleOf } = createLayer()
    layer.setIdle(idle, 0)

    expect(layer.playGesture(nod)).toBe(true)
    expect(idleOf('head').weight).toBe(0)
    expect([idleOf('leftArm'), idleOf('rightArm'), idleOf('torso'), idleOf('base')].every(action => action.weight === 1)).toBe(true)

    layer.update(0.5)
    expect(layer.playing).toBe(true)
    layer.update(0.5)
    expect(idleOf('head')).toMatchObject({ weight: 1, enabled: true, resets: 1 })
    layer.update(0.5)
    expect(layer.playing).toBe(false)
  })

  it('gives the parts of one gesture back when the next one starts', () => {
    const { layer, idleOf, actions } = createLayer()
    layer.setIdle(idle, 0)

    layer.playGesture(nod)
    layer.playGesture(wave)

    expect(idleOf('head').weight).toBe(1)
    expect(idleOf('rightArm').weight).toBe(0)
    expect(actions.find(action => action.clip.name === 'nod')?.playing).toBe(false)
  })

  it('refuses a clip that moves no gesture part, and stops a gesture for a motion of the whole body', () => {
    const { layer, idleOf } = createLayer()
    layer.setIdle(idle, 0)

    expect(layer.playGesture({ name: 'walk', tracks: ['hips.position'], duration: 1 })).toBe(false)

    layer.playGesture(wave)
    layer.fadeIdleOut()
    expect(layer.playing).toBe(false)
    expect(idleOf('rightArm').weight).toBe(0)
    expect(idleOf('base').weight).toBe(0)

    layer.fadeIdleIn()
    expect([idleOf('head'), idleOf('rightArm'), idleOf('base')].every(action => action.weight === 1 && action.resets === 2)).toBe(true)
  })
})
