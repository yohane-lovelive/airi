import type { BrowserWindow } from 'electron'

import type { ChatFloatingState } from '../../../shared/eventa'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { electronChatFloatingContentHidden, electronChatFloatingStateChanged } from '../../../shared/eventa'
import { setupFloatingChatWindow } from './floating'

interface Bounds { x: number, y: number, width: number, height: number }

const doubles = vi.hoisted(() => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 }

  /** A window with only what the floating chat calls on its window and on the main window. */
  class WindowDouble {
    bounds = { x: 0, y: 0, width: 300, height: 260 }
    visible = false
    readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    readonly webContents = { isDestroyed: () => false, isCrashed: () => false }

    on(event: string, listener: (...args: unknown[]) => void) {
      if (!this.listeners.has(event))
        this.listeners.set(event, new Set())
      this.listeners.get(event)!.add(listener)
      return this
    }

    off(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.get(event)?.delete(listener)
      return this
    }

    emit(event: string) {
      for (const listener of this.listeners.get(event) ?? [])
        listener()
    }

    getBounds() {
      return { ...this.bounds }
    }

    setBounds(bounds: { x: number, y: number, width: number, height: number }) {
      this.bounds = { ...bounds }
    }

    isVisible() {
      return this.visible
    }

    hide() {
      this.visible = false
    }

    showInactive() {
      this.visible = true
    }

    isDestroyed = () => false
    isFocused = () => false
    isMinimized = () => false
    isAlwaysOnTop = () => false
    destroy = () => {}
    moveTop = () => {}
    restore = () => {}
    setAlwaysOnTop = () => {}
    setIgnoreMouseEvents = () => {}
    setParentWindow = () => {}
    setFullScreenable = () => {}
    setWindowButtonVisibility = () => {}
  }

  return { WindowDouble, display: { workArea, bounds: workArea } }
})

// NOTICE:
// A test double for the real `BrowserWindow`, which needs the Electron binary.
// Removal condition: unit tests running inside an Electron-based test runner.
vi.mock('electron', () => ({
  BrowserWindow: doubles.WindowDouble,
  screen: {
    getDisplayMatching: () => doubles.display,
    getAllDisplays: () => [doubles.display],
  },
}))

vi.mock('../../../../resources/icon.png?asset', () => ({ default: 'icon.png' }))

vi.mock('../../libs/electron/location', () => ({
  baseUrl: () => 'http://localhost',
  getPreloadPath: () => 'preload.js',
  getRendererRoot: () => '',
  load: vi.fn(async () => {}),
  withHashRoute: (url: string) => url,
}))

// The chat window shows when it gets focus, as the real focus helper does.
vi.mock('../../libs/electron/focus', () => ({
  focusWindow: (window: { showInactive: () => void }) => {
    window.showInactive()
    return true
  },
}))

vi.mock('../shared/app-icon', () => ({ showWindowOnAllWorkspaces: vi.fn() }))

vi.mock('../shared/window', async importOriginal => ({
  ...await importOriginal<typeof import('../shared/window')>(),
  protectPrivilegedWindowNavigation: vi.fn(),
}))

const ipc = vi.hoisted(() => ({
  handlers: new Map<unknown, (payload?: unknown) => unknown>(),
  emitted: [] as Array<{ event: unknown, body: unknown }>,
}))

vi.mock('../../libs/electron/window-context', () => ({
  createWindowContext: () => ({
    context: { emit: (event: unknown, body: unknown) => ipc.emitted.push({ event, body }) },
  }),
}))

vi.mock('@moeru/eventa', async importOriginal => ({
  ...await importOriginal<typeof import('@moeru/eventa')>(),
  defineInvokeHandler: (_context: unknown, event: unknown, handler: (payload?: unknown) => unknown) => {
    ipc.handlers.set(event, handler)
    return () => ipc.handlers.delete(event)
  },
}))

/** The last chat state that the main process sent to the renderer. */
function lastState() {
  const states = ipc.emitted.filter(entry => entry.event === electronChatFloatingStateChanged)
  return states.at(-1)?.body as ChatFloatingState | undefined
}

/** An attached chat, opened beside a main window that has room on its left. */
async function openAttachedChat() {
  const main = new doubles.WindowDouble()
  main.bounds = { x: 1000, y: doubles.display.workArea.height - 700, width: 400, height: 700 }

  const chat = setupFloatingChatWindow({
    getMainWindow: () => main as unknown as BrowserWindow,
    getPlacement: () => 'attached',
    getDanmaku: () => false,
    getPinned: () => false,
    getBounds: () => ({ width: 300, height: 260 }),
    saveBounds: vi.fn(),
    setupChatInvokes: vi.fn(async () => {}),
    onFoldedChange: vi.fn(),
  })
  await chat.open()
  return { main, chat }
}

/** Moves the main window so far left that the chat no longer fits there, and must move to the right side. */
function moveMainToLeftEdge(main: { bounds: Bounds, emit: (event: string) => void }) {
  main.bounds = { ...main.bounds, x: 100 }
  main.emit('move')
}

describe('setupFloatingChatWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ipc.handlers.clear()
    ipc.emitted.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ROOT CAUSE:
  //
  // A move to the other side waited for the renderer to report the hidden content. A page that reloaded during the
  // move never reported it, so the window stayed shown and empty beside the character.
  //
  // We fixed this by finishing the move after a timeout.
  it('finishes a move to the other side when the renderer never reports the hidden content', async () => {
    const { main, chat } = await openAttachedChat()
    expect(lastState()).toMatchObject({ side: 'left', folded: false, relocating: false })

    moveMainToLeftEdge(main)
    expect(lastState()).toMatchObject({ relocating: true })

    vi.advanceTimersByTime(1000)

    expect(lastState()).toMatchObject({ side: 'right', relocating: false })
    expect(chat.getOpenWindow()?.getBounds().x).toBe(main.bounds.x + main.bounds.width)
  })

  it('finishes the move once when the renderer reports the hidden content in time', async () => {
    const { main } = await openAttachedChat()

    moveMainToLeftEdge(main)
    await ipc.handlers.get(electronChatFloatingContentHidden)?.()
    const statesAfterReport = ipc.emitted.length
    vi.advanceTimersByTime(1000)

    expect(lastState()).toMatchObject({ side: 'right', relocating: false })
    expect(ipc.emitted).toHaveLength(statesAfterReport)
  })
})
