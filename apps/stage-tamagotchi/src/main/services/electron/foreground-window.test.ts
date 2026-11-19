import type { DesktopWindowInfo } from '../../../shared/eventa'

import process from 'node:process'

import { createContext, defineInvoke } from '@moeru/eventa'
import { desktopCapturer } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { electronOpenWindows } from '../../../shared/eventa'
import { createForegroundWindowService, withCapturableWindows } from './foreground-window'

const openWindows = vi.hoisted(() => vi.fn())

// The window list of the system and the window sources of Electron are the boundary of this service.
vi.mock('get-windows', () => ({ openWindows, activeWindow: vi.fn() }))
vi.mock('electron', () => ({ desktopCapturer: { getSources: vi.fn() } }))

const GAME: DesktopWindowInfo = { id: 100, title: 'Some Game (TM) Client', app: 'Some Game', path: 'C:\\Games\\game.exe' }

function listedWindow(window: DesktopWindowInfo) {
  return { id: window.id, title: window.title, owner: { name: window.app, path: window.path } }
}

describe('withCapturableWindows', () => {
  it('adds a window that only the capture sources list, with its title and after the listed windows', () => {
    const windows = withCapturableWindows([GAME], [
      { id: 'window:100:0', name: 'Some Game (TM) Client' },
      { id: 'window:69246:0', name: 'Some Game' },
    ])

    expect(windows).toEqual([GAME, { id: 69246, title: 'Some Game', app: '', path: '' }])
  })

  it('leaves out a source without a title, a source of a display, and a second source of one window', () => {
    const windows = withCapturableWindows([], [
      { id: 'window:7:0', name: '  ' },
      { id: 'screen:0:0', name: 'Screen 1' },
      { id: 'window:8:0', name: 'Launcher' },
      { id: 'window:8:1', name: 'Launcher' },
    ])

    expect(windows).toEqual([{ id: 8, title: 'Launcher', app: '', path: '' }])
  })
})

describe('the open windows of the foreground window service', () => {
  const platform = process.platform

  function setup() {
    const context = createContext()
    createForegroundWindowService({ context: context as never })
    return defineInvoke(context, electronOpenWindows)
  }

  beforeEach(() => {
    openWindows.mockResolvedValue([listedWindow(GAME)])
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([{ id: 'window:69246:0', name: 'Some Game' }] as never)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform })
    vi.clearAllMocks()
  })

  // The launcher of a game can be a window without a caption. The window list of the system skips it on Windows.
  it('lists a window that only Electron can capture on Windows, so a commentary finds the launcher after a match', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    expect(await setup()()).toEqual([GAME, { id: 69246, title: 'Some Game', app: '', path: '' }])
  })

  it('reads no window sources on another system, where the read can open a permission prompt', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    expect(await setup()()).toEqual([GAME])
    expect(desktopCapturer.getSources).not.toHaveBeenCalled()
  })

  it('keeps the listed windows when the window sources fail', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.mocked(desktopCapturer.getSources).mockRejectedValue(new Error('no sources'))

    expect(await setup()()).toEqual([GAME])
  })
})
