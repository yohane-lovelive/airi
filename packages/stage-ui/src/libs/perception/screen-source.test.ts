import { describe, expect, it } from 'vitest'

import { windowOfApp } from './screen-source'

describe('windowOfApp', () => {
  it('matches a part of the app name without case', () => {
    expect(windowOfApp({ app: 'League of Legends', title: 'League of Legends (TM) Client' }, 'league')).toBe(true)
  })

  // ROOT CAUSE:
  // The front check of a commentary read only the app name, so a commentary of a window title never took a frame.
  it('matches a part of the title, so a commentary can name a window of a browser or of Electron', () => {
    expect(windowOfApp({ app: 'Electron', title: 'DEMO ARENA' }, 'Demo Arena')).toBe(true)
  })

  it('does not match another window, or an empty name', () => {
    expect(windowOfApp({ app: 'Code', title: 'perception-runner.ts - airi' }, 'League')).toBe(false)
    expect(windowOfApp({ app: 'Code', title: 'airi' }, '  ')).toBe(false)
  })
})
