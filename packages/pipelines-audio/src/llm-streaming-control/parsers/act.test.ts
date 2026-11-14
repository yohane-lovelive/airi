import { describe, expect, it } from 'vitest'

import { tokenAct } from './act'

const parse = (special: string) => tokenAct().parse(special)

describe('act parser', () => {
  it('reads a correct marker as it is', () => {
    expect(parse('<|ACT {"emotion":{"name":"happy","intensity":0.8},"motion":"wave"}|>')).toEqual({
      type: 'act',
      payload: { emotion: { name: 'happy', intensity: 0.8 }, motion: 'wave' },
    })
  })

  // ROOT CAUSE:
  // The model sometimes closes the object of a marker wrongly. A live check on 2026-11-05 lost the emotion and the
  // gesture of each such marker, because the parser dropped any payload that JSON.parse refused.
  it('fixes an object that closes early, closes twice, or does not close', () => {
    expect(parse('<|ACT {"emotion":"curious"},"motion":"tilt-head"}|>')?.payload).toEqual({ emotion: 'curious', motion: 'tilt-head' })
    expect(parse('<|ACT {"emotion":"happy","intensity":0.7}}|>')?.payload).toEqual({ emotion: 'happy', intensity: 0.7 })
    expect(parse('<|ACT {"emotion":{"name":"curious","intensity":0.8},"motion":"nod"}}|>')?.payload).toEqual({ emotion: { name: 'curious', intensity: 0.8 }, motion: 'nod' })
    expect(parse('<|ACT {"emotion":{"name":"sad","intensity":0.5}|>')?.payload).toEqual({ emotion: { name: 'sad', intensity: 0.5 } })
  })

  it('keeps brackets inside strings, and refuses a payload that it cannot fix', () => {
    expect(parse('<|ACT {"motion":"draw a } in the air"}|>')?.payload).toEqual({ motion: 'draw a } in the air' })
    expect(parse('<|ACT {"motion":"unclosed}|>')).toBeUndefined()
    expect(parse('<|ACT happy|>')).toBeUndefined()
    expect(parse('<|ACT ["happy"]|>')).toBeUndefined()
  })
})
