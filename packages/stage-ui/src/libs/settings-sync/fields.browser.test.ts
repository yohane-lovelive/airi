import { useLocalStorage } from '@vueuse/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick } from 'vue'

import { applySettingsChanges, notifyThisWindow } from './fields'

describe('applySettingsChanges in a browser', () => {
  let scope: ReturnType<typeof effectScope>

  beforeEach(() => {
    scope = effectScope()
  })

  afterEach(() => {
    scope.stop()
    localStorage.clear()
  })

  it('updates an open setting of this window', async () => {
    const voice = scope.run(() => useLocalStorage('settings/speech/voice', 'alloy'))!
    const pitch = scope.run(() => useLocalStorage('settings/speech/pitch', 1))!
    expect(voice.value).toBe('alloy')

    applySettingsChanges(localStorage, {
      upserts: { speech: { 'settings/speech/voice': 'nova', 'settings/speech/pitch': '0.8' } },
      removals: [],
      conflictCopies: [],
    }, notifyThisWindow)
    await nextTick()

    expect(localStorage.getItem('settings/speech/voice')).toBe('nova')
    expect(voice.value).toBe('nova')
    // VueUse reads the raw string with the serializer of the default, so a number stays a number.
    expect(pitch.value).toBe(0.8)
  })

  it('returns an open setting to its default when the server removed it', async () => {
    localStorage.setItem('settings/speech/rate', '1.5')
    const rate = scope.run(() => useLocalStorage('settings/speech/rate', 1))!
    expect(rate.value).toBe(1.5)

    applySettingsChanges(localStorage, { upserts: { speech: {} }, removals: [], conflictCopies: [] }, notifyThisWindow)
    await nextTick()

    expect(rate.value).toBe(1)
  })
})
