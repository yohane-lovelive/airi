import type { SettingChange } from './fields'

import { describe, expect, it } from 'vitest'

import { applySettingsChanges, readSettingsDocuments } from './fields'
import { SETTINGS_SYNC_GROUPS, SETTINGS_SYNC_KEY_GROUPS } from './groups'

/** A `Storage` in memory, so the test runs without a browser. */
function memoryStorage(entries: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(entries))
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  }
}

function changes(overrides: Partial<{ upserts: Record<string, Record<string, unknown>>, removals: string[] }>) {
  return { upserts: {}, removals: [], conflictCopies: [{ documentId: 'speech', fields: { 'settings/speech/voice': 'lost' } }], ...overrides }
}

describe('settings sync groups', () => {
  it('leaves out secrets and values of one device', () => {
    const keys = [...SETTINGS_SYNC_KEY_GROUPS.keys()]

    expect(keys.filter(key => /api-key|token|secret|voiceprint|credential/.test(key))).toEqual([])
    expect(keys.filter(key => /audio\/input|always-on-top|developer|websocket|server-channel|max-fps|render-scale|camera|discord|twitter|missions/.test(key))).toEqual([])
  })

  it('puts each key in one group', () => {
    const count = Object.values(SETTINGS_SYNC_GROUPS).reduce((sum, keys) => sum + keys.length, 0)

    expect(SETTINGS_SYNC_KEY_GROUPS.size).toBe(count)
  })
})

describe('readSettingsDocuments', () => {
  it('reads the raw stored strings of the allowed keys by group', () => {
    const storage = memoryStorage({
      'settings/speech/voice': 'alloy',
      'settings/speech/pitch': '1.2',
      'settings/language': 'ja',
      'settings/web-search/api-key': 'secret',
    })

    expect(readSettingsDocuments(storage)).toEqual({
      general: { 'settings/language': 'ja' },
      speech: { 'settings/speech/voice': 'alloy', 'settings/speech/pitch': '1.2' },
    })
  })
})

describe('applySettingsChanges', () => {
  it('writes a received group, removes the keys that it lacks, and reports each change', () => {
    const storage = memoryStorage({ 'settings/speech/voice': 'alloy', 'settings/speech/rate': '1' })
    const reported: SettingChange[] = []

    const result = applySettingsChanges(storage, changes({ upserts: { speech: { 'settings/speech/voice': 'nova', 'settings/speech/pitch': '0.9' } } }), change => reported.push(change))

    expect(result).toEqual({ rejected: [] })
    expect(storage.getItem('settings/speech/voice')).toBe('nova')
    expect(storage.getItem('settings/speech/pitch')).toBe('0.9')
    expect(storage.getItem('settings/speech/rate')).toBeNull()
    // Keys are written in the order of the allow list.
    expect(reported).toEqual([
      { key: 'settings/speech/voice', oldValue: 'alloy', newValue: 'nova' },
      { key: 'settings/speech/pitch', oldValue: null, newValue: '0.9' },
      { key: 'settings/speech/rate', oldValue: '1', newValue: null },
    ])
  })

  it('ignores keys outside the allow list and drops conflict copies', () => {
    const storage = memoryStorage()

    applySettingsChanges(storage, changes({ upserts: { general: { 'settings/language': 'en', 'settings/web-search/api-key': 'leaked' } } }), () => {})

    expect(storage.getItem('settings/language')).toBe('en')
    expect(storage.getItem('settings/web-search/api-key')).toBeNull()
    expect(storage.getItem('settings/speech/voice')).toBeNull()
  })

  it('removes every key of a removed group', () => {
    const storage = memoryStorage({ 'settings/spine/idle-enabled': 'true', 'settings/spine/max-fps': '30' })

    applySettingsChanges(storage, changes({ removals: ['spine'] }), () => {})

    expect(storage.getItem('settings/spine/idle-enabled')).toBeNull()
    // A device value is not part of the group, so it stays.
    expect(storage.getItem('settings/spine/max-fps')).toBe('30')
  })

  it('rejects a group that this version of the app does not know, so its server copy stays', () => {
    const storage = memoryStorage()

    const result = applySettingsChanges(storage, changes({ upserts: { future: { 'settings/future/x': '1' } } }), () => {})

    expect(result).toEqual({ rejected: ['future'] })
    expect(storage.length).toBe(0)
  })
})
