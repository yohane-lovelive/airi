import { describe, expect, it } from 'vitest'

import { DEVICE_ID_KEY, deviceId } from './device-id'

function memoryStorage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values }
}

describe('deviceId', () => {
  it('makes a random id once and reads the same one later', () => {
    const storage = memoryStorage()

    const first = deviceId(storage)

    expect(first).toMatch(/^[\da-f-]{36}$/)
    expect(deviceId(storage)).toBe(first)
    expect(storage.values.get(DEVICE_ID_KEY)).toBe(first)
    expect(deviceId(memoryStorage())).not.toBe(first)
  })
})
