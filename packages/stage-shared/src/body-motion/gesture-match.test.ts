import { describe, expect, it } from 'vitest'

import { matchGesture } from './gesture-match'
import { BUILT_IN_GESTURES } from './gestures'

describe('matchGesture', () => {
  it.each([
    ['nods happily', 'nod'],
    ['小さくうなずく', 'nod'],
    ['waving goodbye', 'wave'],
    ['手を振って挨拶', 'wave'],
    ['tilts head, puzzled', 'tilt-head'],
    ['首をかしげる', 'tilt-head'],
    ['shrugs', 'shrug'],
    ['腕を組んで考える', 'cross-arms'],
    ['ほっとして胸に手を当てる', 'hand-on-chest'],
    ['bows to apologize', 'bow'],
    ['深くお辞儀', 'bow'],
    ['ガッツポーズ', 'fist-pump'],
  ])('chooses the gesture for %s', (motion, id) => {
    expect(matchGesture(motion, BUILT_IN_GESTURES)).toBe(id)
  })

  it('chooses nothing for a motion that no gesture fits, or for a short word inside a longer one', () => {
    expect(matchGesture('jumps around the room', BUILT_IN_GESTURES)).toBeUndefined()
    expect(matchGesture('', BUILT_IN_GESTURES)).toBeUndefined()
    expect(matchGesture('this', [{ id: 'hi', tags: ['hi'], description: '' }])).toBeUndefined()
  })

  it('chooses a gesture by the name that the prompt lists', () => {
    const candidates = BUILT_IN_GESTURES.map(gesture => ({ ...gesture, name: gesture.id }))

    expect(matchGesture('tilt-head', candidates)).toBe('tilt-head')
    expect(matchGesture('hand-on-chest', candidates)).toBe('hand-on-chest')
  })

  it('counts description words when no tag fits', () => {
    const candidates = [{ id: 'spin', tags: [], description: 'Spins around once, playful.' }]

    expect(matchGesture('spins around', candidates)).toBe('spin')
    expect(matchGesture('spins', candidates)).toBeUndefined()
  })
})
