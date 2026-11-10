import type { StageSidecarEnvelope, StageSidecarHost, StageSidecarHostOptions } from '.'
import type { ElectronStageSidecarStatus } from '../../../../shared/eventa'

import process from 'node:process'

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createStageSidecarHost, materializeFile, materializePackage } from '.'

const FAKE_SIDECAR = resolve(import.meta.dirname, '../../../../../scripts/fake-stage-sidecar.mjs')

describe('createStageSidecarHost', () => {
  let hosts: StageSidecarHost[] = []
  let sockets: WebSocket[] = []
  let directory = ''
  let logPath = ''

  function createHost(options: Partial<StageSidecarHostOptions> = {}) {
    const host = createStageSidecarHost({
      label: 'Test stage',
      name: 'test-stage',
      resolveLaunch: async websocketUrl => ({
        args: [FAKE_SIDECAR, `--airi-ws-url=${websocketUrl}`],
        executable: process.execPath,
        kind: 'process',
      }),
      ...options,
    })
    hosts.push(host)
    return host
  }

  /** A host in attach mode, and the URL that the launch gave to the sidecar. */
  function createAttachHost(options: Partial<StageSidecarHostOptions> = {}) {
    const attach: { url: string } = { url: '' }
    const host = createHost({
      resolveLaunch: async (websocketUrl) => {
        attach.url = websocketUrl
        return { kind: 'attach' }
      },
      ...options,
    })
    return { attach, host }
  }

  /** Connects in place of the Editor. */
  async function connect(url: string) {
    const socket = new WebSocket(url)
    sockets.push(socket)
    await new Promise((resolvePromise, reject) => {
      socket.addEventListener('open', resolvePromise, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return socket
  }

  function received() {
    if (!existsSync(logPath))
      return []

    return readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as StageSidecarEnvelope)
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'airi-stage-sidecar-'))
    logPath = join(directory, 'received.jsonl')
    vi.stubEnv('FAKE_SIDECAR_LOG', logPath)
    vi.stubEnv('FAKE_SIDECAR_MODE', 'normal')
  })

  afterEach(async () => {
    sockets.forEach(socket => socket.close())
    sockets = []
    await Promise.all(hosts.map(host => host.stop().catch(() => {})))
    hosts = []
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  it('names the sidecar in its errors', async () => {
    vi.stubEnv('FAKE_SIDECAR_MODE', 'crash')
    const host = createHost()

    await expect(host.start()).rejects.toThrow('Test stage exited with code 3.')
  })

  it('fails the start when the sidecar does not report ready in time', async () => {
    vi.stubEnv('FAKE_SIDECAR_MODE', 'no-ready')
    const host = createHost({ readyTimeoutMs: 300 })

    await expect(host.start()).rejects.toThrow('Test stage did not report ready in time.')

    expect(host.getStatus().state).toBe('error')
  })

  it('waits for a slow exit after a stop, as long as the owner allows', async () => {
    vi.stubEnv('FAKE_SIDECAR_MODE', 'slow-exit')
    vi.stubEnv('FAKE_SIDECAR_EXIT_DELAY_MS', '600')
    const host = createHost({ exitTimeoutMs: 3_000 })
    await host.start()

    const status = await host.stop()

    expect(status.state).toBe('stopped')
    expect(received().map(message => message.type)).toContain('fake.exit')
  })

  it('ends a sidecar that does not exit in the time of the owner', async () => {
    vi.stubEnv('FAKE_SIDECAR_MODE', 'slow-exit')
    vi.stubEnv('FAKE_SIDECAR_EXIT_DELAY_MS', '1500')
    const host = createHost({ exitTimeoutMs: 300 })
    await host.start()

    const status = await host.stop()

    expect(status.state).toBe('stopped')
    expect(received().map(message => message.type)).not.toContain('fake.exit')
  })

  it('fails the start when the launch cannot be resolved, without a socket left open', async () => {
    const host = createHost({
      resolveLaunch: async () => {
        throw new Error('No executable.')
      },
    })

    await expect(host.start()).rejects.toThrow('No executable.')

    expect(host.getStatus().state).toBe('error')
    expect(host.getStatus().lastError).toBe('No executable.')
    expect(host.send('host.shutdown')).toBe(false)
  })

  it('sends messages to a running sidecar', async () => {
    const host = createHost()
    await host.start()

    expect(host.send('host.character.idle', { path: 'a' })).toBe(true)

    await vi.waitFor(() => expect(received()).toEqual([{ type: 'host.character.idle', payload: { path: 'a' } }]))
  })

  it('reports that nothing is connected instead of queueing a message', () => {
    const host = createHost()

    expect(host.send('host.character.idle', { path: 'a' })).toBe(false)
  })

  it('gives the owner the messages that the host does not own, and scene.applied', async () => {
    const seen: string[] = []
    const { attach, host } = createAttachHost({
      onMessage: (message) => {
        seen.push(message.type)
        return true
      },
    })
    await host.start()
    const socket = await connect(attach.url)

    socket.send(JSON.stringify({ type: 'stage.ready' }))
    socket.send(JSON.stringify({ type: 'character.error', payload: { message: 'a', type: 'b' } }))
    socket.send(JSON.stringify({ type: 'scene.applied', payload: {} }))

    await vi.waitFor(() => expect(seen).toEqual(['character.error', 'scene.applied']))
  })

  it('keeps the connection after a message that is not JSON', async () => {
    const { attach, host } = createAttachHost()
    await host.start()
    const socket = await connect(attach.url)

    socket.send('{ not json')
    socket.send(JSON.stringify({ type: 'stage.ready' }))

    await vi.waitFor(() => expect(host.getStatus().state).toBe('running'))
  })

  it('records an error that does not end the sidecar', async () => {
    const host = createHost()
    await host.start()

    host.reportError('This model format has no loader.')

    expect(host.getStatus().state).toBe('running')
    expect(host.getStatus().lastError).toBe('This model format has no loader.')
  })

  it('refuses a connection with a wrong token', async () => {
    const { attach, host } = createAttachHost()
    await host.start()
    const wrong = new URL(attach.url)
    wrong.searchParams.set('token', 'wrong')

    const socket = new WebSocket(wrong)
    sockets.push(socket)
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED))

    expect(host.send('host.shutdown')).toBe(false)
    expect(host.getStatus().state).toBe('starting')
  })

  describe('in attach mode', () => {
    it('returns from start at once and waits for the connection', async () => {
      const { attach, host } = createAttachHost()

      const status = await host.start()

      expect(status.state).toBe('starting')
      expect(status.pid).toBeNull()
      expect(attach.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws\?token=/)
    })

    it('runs when the sidecar reports ready', async () => {
      const { attach, host } = createAttachHost()
      await host.start()

      const socket = await connect(attach.url)
      socket.send(JSON.stringify({ type: 'stage.ready' }))

      await vi.waitFor(() => expect(host.getStatus().state).toBe('running'))
      expect(host.getStatus().pid).toBeNull()
    })

    it('keeps its socket when start runs twice', async () => {
      const { attach, host } = createAttachHost()
      await host.start()
      const firstUrl = attach.url

      await host.start()

      expect(attach.url).toBe(firstUrl)
    })

    it('waits again when the sidecar leaves, and accepts it back on the same URL', async () => {
      const ended = vi.fn()
      const { attach, host } = createAttachHost({ onSessionEnd: ended })
      const states: ElectronStageSidecarStatus['state'][] = []
      await host.start()
      host.subscribe(status => states.push(status.state))

      const first = await connect(attach.url)
      first.send(JSON.stringify({ type: 'stage.ready' }))
      await vi.waitFor(() => expect(host.getStatus().state).toBe('running'))

      first.close()
      await vi.waitFor(() => expect(host.getStatus().state).toBe('starting'))
      expect(ended).toHaveBeenCalledTimes(1)
      expect(host.send('host.shutdown')).toBe(false)

      const second = await connect(attach.url)
      second.send(JSON.stringify({ type: 'stage.ready' }))
      await vi.waitFor(() => expect(host.getStatus().state).toBe('running'))

      expect(states).toEqual(['starting', 'running', 'starting', 'running'])
    })

    it('tells a connected sidecar about the stop, and closes the socket', async () => {
      const { attach, host } = createAttachHost()
      await host.start()
      const socket = await connect(attach.url)
      const messages: string[] = []
      socket.addEventListener('message', event => messages.push(event.data))
      socket.send(JSON.stringify({ type: 'stage.ready' }))
      await vi.waitFor(() => expect(host.getStatus().state).toBe('running'))

      const status = await host.stop()

      expect(status.state).toBe('stopped')
      await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED))
      expect(messages).toEqual([JSON.stringify({ type: 'host.shutdown' })])
    })

    it('makes a new URL when it starts after a stop', async () => {
      const { attach, host } = createAttachHost()
      await host.start()
      const firstUrl = attach.url

      await host.stop()
      await host.start()

      expect(attach.url).not.toBe(firstUrl)
      expect(host.getStatus().state).toBe('starting')
    })

    it('starts again after a fatal error', async () => {
      const { attach, host } = createAttachHost()
      await host.start()
      const first = await connect(attach.url)
      first.send(JSON.stringify({ type: 'stage.fatal', payload: { message: 'No URP asset.' } }))
      await vi.waitFor(() => expect(host.getStatus().state).toBe('error'))
      expect(host.getStatus().lastError).toBe('No URP asset.')

      const status = await host.start()

      expect(status.state).toBe('starting')
      expect(status.lastError).toBeUndefined()
    })
  })
})

describe('materializeFile', () => {
  let directory = ''

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'airi-stage-sidecar-file-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('creates the directory and writes the bytes', async () => {
    const target = join(directory, 'a', 'b')

    const path = await materializeFile(target, 'model.vrm', new Uint8Array([1, 2]))

    expect(path).toBe(join(target, 'model.vrm'))
    expect([...readFileSync(path)]).toEqual([1, 2])
  })

  it('keeps a file name from a renderer inside the directory', async () => {
    const target = join(directory, 'models')

    const path = await materializeFile(target, '../../outside.vrm', new Uint8Array([1]))

    expect(path).toBe(join(target, 'outside.vrm'))
    expect(readdirSync(directory)).toEqual(['models'])
  })
})

describe('materializePackage', () => {
  let directory = ''

  function file(path: string) {
    return { path, data: new Uint8Array([1, 2]) }
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'airi-stage-sidecar-package-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('keeps the folders of the package, also with Japanese names and backslashes', async () => {
    const target = join(directory, 'model')

    const path = await materializePackage(target, [file('モデル/結月.pmx'), file('モデル\\tex\\顔.png')], 'モデル/結月.pmx')

    expect(path).toBe(join(target, 'モデル', '結月.pmx'))
    expect([...readFileSync(path)]).toEqual([1, 2])
    expect([...readFileSync(join(target, 'モデル', 'tex', '顔.png'))]).toEqual([1, 2])
  })

  it.each([
    ['a parent folder', '../outside.png'],
    ['a parent folder inside the path', 'tex/../../outside.png'],
    ['a parent folder with backslashes', 'tex\\..\\..\\outside.png'],
    ['an absolute path', '/outside.png'],
    ['a drive path', 'C:/outside.png'],
    ['a stream of a Windows file', 'tex/a.png:stream'],
    ['a null character', 'tex/a\0.png'],
    ['an empty path', ''],
    ['a path with no name', './'],
  ])('refuses %s, and writes nothing', async (_name, unsafe) => {
    const target = join(directory, 'model')

    await expect(materializePackage(target, [file('a.pmx'), file(unsafe)], 'a.pmx')).rejects.toThrow('unsafe path')

    expect(readdirSync(directory)).toEqual([])
  })

  it('refuses a model path that the package does not have', async () => {
    const target = join(directory, 'model')

    await expect(materializePackage(target, [file('a.pmx')], 'b.pmx')).rejects.toThrow('has no file at b.pmx')

    expect(readdirSync(directory)).toEqual([])
  })
})
