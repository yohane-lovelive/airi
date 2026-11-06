import { describe, expect, it } from 'vitest'

import fixtures from './protocol-fixtures.json'

import { quaternionFromEuler } from '../body-motion/pose-applier'
import { HostMessageSchema, parseHostMessage, parseSidecarMessage, SidecarMessageSchema } from './protocol'

/**
 * The C# tests of `engines/stage-tamagotchi-unity` read the same file. So a change of the protocol fails on the side
 * that did not follow it.
 */
describe('stage sidecar protocol', () => {
  it('has an example of each host message', () => {
    const types = new Set(fixtures.hostMessages.map(message => message.type))
    const expected = new Set(HostMessageSchema.options.map(option => option.entries.type.literal))

    expect(types).toEqual(expected)
  })

  it('has an example of each sidecar message', () => {
    const types = new Set(fixtures.sidecarMessages.map(message => message.type))
    const expected = new Set(SidecarMessageSchema.options.map(option => option.entries.type.literal))

    expect(types).toEqual(expected)
  })

  it.each(fixtures.hostMessages.map(message => [message.type, message] as const))('accepts %s', (_type, message) => {
    expect(parseHostMessage(message)).toEqual(message)
  })

  it.each(fixtures.sidecarMessages.map(message => [message.type, message] as const))('accepts %s', (_type, message) => {
    expect(parseSidecarMessage(message)).toEqual(message)
  })

  it.each(fixtures.invalidHostMessages.map(entry => [entry.reason, entry.message] as const))('rejects a host message: %s', (_reason, message) => {
    expect(() => parseHostMessage(message)).toThrow('Invalid stage sidecar host message.')
  })

  it.each(fixtures.invalidSidecarMessages.map(entry => [entry.reason, entry.message] as const))('rejects a sidecar message: %s', (_reason, message) => {
    expect(() => parseSidecarMessage(message)).toThrow('Invalid stage sidecar message.')
  })

  it.each(fixtures.rotations.map(entry => [entry.euler, entry.quaternion] as const))('gives the fixture quaternion for the Euler angles %j', (euler, quaternion) => {
    const actual = quaternionFromEuler(euler)

    for (const [index, value] of quaternion.entries())
      expect(actual[index]).toBeCloseTo(value, 8)
  })
})
