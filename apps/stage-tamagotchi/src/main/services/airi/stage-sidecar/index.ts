import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

import type { WebSocketMessage, WebSocketPeer } from 'h3'
import type { InferOutput } from 'valibot'

import type { ElectronStageSidecarStatus } from '../../../../shared/eventa'

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { useLogg } from '@guiiai/logg'
import { errorMessageFrom } from '@moeru/std'
import { Mutex } from 'async-mutex'
import { plugin as ws } from 'crossws/server'
import { safeDestr } from 'destr'
import { getRandomPort } from 'get-port-please'
import { defineWebSocketHandler, H3, serve } from 'h3'
import { instance, literal, object, optional, safeParse, string, unknown as unknownSchema } from 'valibot'

type StageSidecarProcess = ChildProcessByStdio<null, Readable, Readable>

/** A stop or a restart must not hang on the socket server, because it holds the lifecycle lock. */
const SOCKET_CLOSE_TIMEOUT_MS = 1_000

interface Deferred<T> {
  promise: Promise<T>
  reject: (error?: unknown) => void
  resolve: (value: PromiseLike<T> | T) => void
}

interface SocketRuntime {
  port: number
  server: ReturnType<typeof serve>
  token: string
}

export interface ListenerChannel<T> {
  publish: (payload: T) => void
  subscribe: (callback: (payload: T) => void) => () => void
}

const sceneInputPayloadSchema = object({
  data: instance(Uint8Array),
  fileName: string(),
  format: literal('vrm'),
  modelId: string(),
  name: string(),
})

const socketEnvelopeSchema = object({
  payload: optional(unknownSchema()),
  type: string(),
})

const payloadMessageSchema = object({
  message: string(),
})

/** One message of the WebSocket of a sidecar. Its owner parses `payload`. */
export type StageSidecarEnvelope = InferOutput<typeof socketEnvelopeSchema>

/** The model of a renderer, on its way to a sidecar. */
export type StageSidecarSceneInput = InferOutput<typeof sceneInputPayloadSchema>

/**
 * How a sidecar connects.
 *
 * - `process`: the host starts the executable, and the sidecar lives as long as this process.
 * - `attach`: the host starts nothing and waits. A developer starts Play mode in the Editor, and it can stop and connect
 *   again while the host runs.
 */
export type StageSidecarLaunch
  = | { kind: 'process', executable: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv }
    | { kind: 'attach' }

export interface StageSidecarHostOptions {
  /** The name of the log, for example `godot-stage`. */
  name: string
  /** The name of the sidecar in error messages, for example `Godot stage`. */
  label: string
  /**
   * Decides how the sidecar connects, after the socket exists. An error here fails the start.
   *
   * @param websocketUrl The URL with its token. The sidecar connects to it.
   */
  resolveLaunch: (websocketUrl: string) => Promise<StageSidecarLaunch>
  /**
   * Receives the messages that the host does not own. The host owns `stage.ready`, `stage.fatal`, `scene.applied`, and
   * `scene.error`.
   *
   * @returns whether the message had an owner. The host logs the others.
   */
  onMessage?: (message: StageSidecarEnvelope) => boolean
  /** Runs when the current sidecar is gone, so the owner can drop the state of that sidecar. */
  onSessionEnd?: () => void
  /** @default 20000 */
  readyTimeoutMs?: number
  /**
   * The time that the sidecar gets to exit after `host.shutdown`. Then the host ends the process.
   *
   * @default 2000
   */
  exitTimeoutMs?: number
}

/**
 * The lifecycle of one display sidecar, owned by Electron main.
 *
 * Status model:
 * - `stopped` -> `starting` -> `running` -> `stopping` -> `stopped`.
 * - `error` holds the last failure. A later `start` leaves it.
 * - In attach mode, `starting` means that the host waits for a connection. `start` returns at once, and `running` comes
 *   with `stage.ready`. When the sidecar disconnects, the status returns to `starting`.
 *
 * `start`, `stop`, and {@link StageSidecarHost.runExclusive} run one at a time. {@link StageSidecarHost.send} does not
 * wait for them, so a stream of frames cannot queue behind a slow model write.
 */
export interface StageSidecarHost {
  getStatus: () => ElectronStageSidecarStatus
  /** Runs `task` between the lifecycle changes, so the sidecar cannot stop during the task. */
  runExclusive: <T>(task: () => Promise<T>) => Promise<T>
  /** Records a failure that does not end the sidecar. A later `scene.applied` clears it. */
  reportError: (message: string) => void
  /** @returns false when no sidecar is connected. Nothing queues the message. */
  send: (type: string, payload?: unknown) => boolean
  start: () => Promise<ElectronStageSidecarStatus>
  stop: () => Promise<ElectronStageSidecarStatus>
  /** The callback also runs once at once, with the current status. */
  subscribe: (callback: (status: ElectronStageSidecarStatus) => void) => () => void
}

/**
 * Creates the host of one sidecar.
 *
 * Call stack:
 *
 * createGodotStageManager, createUnityStageManager
 *   -> {@link createStageSidecarHost}
 *     -> child process + WebSocket server on 127.0.0.1
 */
export function createStageSidecarHost(options: StageSidecarHostOptions): StageSidecarHost {
  const { label } = options
  const log = useLogg(`main/${options.name}`).useGlobalConfig()
  const lifecycleMutex = new Mutex()
  const statusListeners = createListenerChannel<ElectronStageSidecarStatus>(
    error => log.withError(error).warn(`failed to publish ${label} status change`),
  )
  let currentStatus = createInitialStatus()
  let currentProcess: StageSidecarProcess | undefined
  let currentProcessExit = createDeferred<void>()
  let currentReady: Deferred<void> | undefined
  let currentSocketRuntime: SocketRuntime | undefined
  let currentSocketPeer: undefined | WebSocketPeer
  let expectedProcessExit = false
  /** True while the host waits for or serves an attach mode connection. */
  let attached = false

  function setStatus(next: Partial<ElectronStageSidecarStatus> & Pick<ElectronStageSidecarStatus, 'state'>) {
    currentStatus = {
      ...currentStatus,
      ...next,
      updatedAt: Date.now(),
    }
    statusListeners.publish(currentStatus)
  }

  function clearProcessState() {
    currentProcess = undefined
    currentSocketPeer = undefined
    options.onSessionEnd?.()
    currentProcessExit.resolve()
    currentProcessExit = createDeferred<void>()
  }

  async function stopSocketRuntime() {
    const runtime = currentSocketRuntime
    const peer = currentSocketPeer
    currentSocketRuntime = undefined
    // The close handler ignores a peer that is not current, so this close does not look like a sidecar that left.
    currentSocketPeer = undefined

    if (!runtime) {
      return
    }

    // `server.close` waits for upgraded sockets, and an attached Editor keeps its socket open. Without this close, the
    // stop never ends and holds the lifecycle lock. A process exits first, so only attach mode reaches this with a peer.
    peer?.close?.()

    await Promise.race([
      runtime.server.close(true).catch(() => {}),
      new Promise<void>(resolve => setTimeout(resolve, SOCKET_CLOSE_TIMEOUT_MS)),
    ])
  }

  async function stopProcessAfterFailedStart() {
    if (!currentProcess) {
      return
    }

    const activeProcess = currentProcess
    const exitPromise = currentProcessExit.promise
    expectedProcessExit = true

    // Startup failed after the spawn. Release the child process before the renderer can retry and create another one.
    activeProcess.kill()

    await waitForProcessExit(exitPromise, 2_000)
  }

  function send(type: string, payload?: unknown) {
    if (!currentSocketPeer) {
      return false
    }

    currentSocketPeer.send(createSocketEnvelope(type, payload))
    return true
  }

  function handleSocketMessage(message: StageSidecarEnvelope) {
    switch (message.type) {
      case 'scene.applied': {
        if (currentStatus.state === 'running' && currentStatus.lastError) {
          setStatus({
            lastError: undefined,
            pid: currentProcess?.pid ?? null,
            state: 'running',
          })
        }
        break
      }
      case 'scene.error': {
        reportError(getPayloadMessage(message.payload) ?? `${label} failed to apply scene input.`)
        return
      }
      case 'stage.fatal': {
        const error = getPayloadMessage(message.payload) ?? `${label} reported a fatal startup error.`
        setStatus({
          lastError: error,
          pid: currentProcess?.pid ?? null,
          state: 'error',
        })
        currentReady?.reject(new Error(error))
        currentReady = undefined
        currentProcess?.kill()
        return
      }
      case 'stage.ready': {
        setStatus({
          lastError: undefined,
          pid: currentProcess?.pid ?? null,
          state: 'running',
        })
        currentReady?.resolve()
        currentReady = undefined

        return
      }
    }

    // `scene.applied` also reaches the owner, which can read the bounds of the avatar.
    if (!options.onMessage?.(message) && message.type !== 'scene.applied') {
      log.withFields({ type: message.type }).debug(`received unknown ${label} message`)
    }
  }

  function reportError(message: string) {
    setStatus({
      lastError: message,
      pid: currentProcess?.pid ?? null,
      state: currentStatus.state,
    })
  }

  async function startSocketRuntime() {
    if (currentSocketRuntime) {
      return currentSocketRuntime
    }

    const host = '127.0.0.1'
    const port = await getRandomPort(host)
    const token = randomUUID()
    const appServer = new H3()

    appServer.get('/ws', defineWebSocketHandler({
      close: (peer) => {
        if (currentSocketPeer?.id !== peer.id) {
          return
        }

        currentSocketPeer = undefined

        // A process has its own exit path. Only an attached sidecar can leave and come back while the host runs.
        if (attached && currentStatus.state === 'running') {
          options.onSessionEnd?.()
          setStatus({
            lastError: undefined,
            pid: null,
            state: 'starting',
          })
        }
      },
      message: (_peer, message) => {
        try {
          handleSocketMessage(parseSocketMessage(message))
        }
        catch (error) {
          log.withError(error).warn(`failed to parse ${label} websocket message`)
        }
      },
      open: (peer) => {
        const requestUrl = peer.request.url ?? ''
        const url = new URL(requestUrl, `ws://${host}:${port}`)
        if (url.searchParams.get('token') !== token) {
          peer.close?.()
          return
        }

        currentSocketPeer = peer
        log.withFields({ peer: peer.id }).debug(`${label} websocket connected`)
      },
    }))

    const server = serve(appServer, {
      gracefulShutdown: {
        forceTimeout: 0.25,
        gracefulTimeout: 0.25,
      },
      hostname: host,
      manual: true,
      // @ts-expect-error - h3 does not extend the crossws response type.
      plugins: [ws({ resolve: async req => (await appServer.fetch(req)).crossws })],
      port,
      reusePort: false,
      silent: true,
    })

    await server.serve()

    currentSocketRuntime = {
      port,
      server,
      token,
    }

    return currentSocketRuntime
  }

  function attachProcessListeners(processHandle: StageSidecarProcess) {
    pipeProcessLog(processHandle.stdout, message => log.log(message))
    pipeProcessLog(processHandle.stderr, message => log.warn(message))

    processHandle.on('error', (error) => {
      if (currentProcess !== processHandle) {
        log.withError(error).debug(`ignored stale ${label} process error`)
        return
      }

      const message = errorMessageFrom(error) ?? `Failed to spawn ${label} process.`
      setStatus({
        lastError: message,
        pid: processHandle.pid ?? null,
        state: 'error',
      })
      currentReady?.reject(error)
      currentReady = undefined
    })

    processHandle.on('close', (code, signal) => {
      if (currentProcess !== processHandle) {
        log.withFields({
          code,
          pid: processHandle.pid ?? null,
          signal,
        }).debug(`ignored stale ${label} process close`)
        return
      }

      const exitMessage = signal
        ? `${label} exited with signal ${signal}.`
        : `${label} exited with code ${code ?? 0}.`

      clearProcessState()
      void stopSocketRuntime()

      if (expectedProcessExit) {
        setStatus({
          lastError: undefined,
          pid: null,
          state: 'stopped',
        })
      }
      else {
        setStatus({
          lastError: exitMessage,
          pid: null,
          state: 'error',
        })
      }

      currentReady?.reject(new Error(exitMessage))
      currentReady = undefined
      expectedProcessExit = false
    })
  }

  return {
    getStatus() {
      return currentStatus
    },
    reportError,
    runExclusive(task) {
      return lifecycleMutex.runExclusive(task)
    },
    send,
    async start() {
      return await lifecycleMutex.runExclusive(async () => {
        let spawnedProcess: StageSidecarProcess | undefined

        try {
          if (currentProcess && currentStatus.state === 'running') {
            return currentStatus
          }

          if (currentProcess && currentStatus.state === 'starting' && currentReady) {
            await currentReady.promise
            return currentStatus
          }

          if (attached && (currentStatus.state === 'starting' || currentStatus.state === 'running')) {
            return currentStatus
          }

          if (currentProcess) {
            const activeProcess = currentProcess
            await stopProcessAfterFailedStart()

            if (currentProcess === activeProcess) {
              throw new Error(`Previous ${label} process is still shutting down. Retry after it exits.`)
            }
          }

          attached = false
          await stopSocketRuntime()

          const socketRuntime = await startSocketRuntime()
          const websocketUrl = `ws://127.0.0.1:${socketRuntime.port}/ws?token=${socketRuntime.token}`
          const launch = await options.resolveLaunch(websocketUrl)

          if (launch.kind === 'attach') {
            attached = true
            log.log(`waiting for ${label} to attach`)
            setStatus({
              lastError: undefined,
              pid: null,
              state: 'starting',
            })
            return currentStatus
          }

          const readyDeferred = createDeferred<void>()
          const readyTimeout = setTimeout(() => {
            readyDeferred.reject(new Error(`${label} did not report ready in time.`))
          }, options.readyTimeoutMs ?? 20_000)

          currentReady = readyDeferred
          expectedProcessExit = false
          setStatus({
            lastError: undefined,
            pid: null,
            state: 'starting',
          })

          log.withFields({ executable: launch.executable }).log(`spawning ${label}`)

          const processHandle = spawn(
            launch.executable,
            launch.args,
            {
              cwd: launch.cwd,
              env: launch.env,
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: false,
            },
          )

          spawnedProcess = processHandle
          currentProcess = processHandle
          attachProcessListeners(processHandle)

          setStatus({
            lastError: undefined,
            pid: processHandle.pid ?? null,
            state: 'starting',
          })

          try {
            await readyDeferred.promise
          }
          finally {
            if (currentReady === readyDeferred)
              currentReady = undefined
            clearTimeout(readyTimeout)
          }

          return currentStatus
        }
        catch (error) {
          if (spawnedProcess && currentProcess === spawnedProcess) {
            await stopProcessAfterFailedStart()
          }
          await stopSocketRuntime()
          setStatus({
            lastError: errorMessageFrom(error) ?? `Failed to start ${label}.`,
            pid: null,
            state: 'error',
          })
          throw error
        }
      })
    },
    async stop() {
      return await lifecycleMutex.runExclusive(async () => {
        if (!currentProcess) {
          // An attached sidecar can stay connected. Without this message it keeps the old session open.
          if (attached) {
            send('host.shutdown')
          }

          attached = false
          await stopSocketRuntime()
          setStatus({
            lastError: undefined,
            pid: null,
            state: 'stopped',
          })
          return currentStatus
        }

        const activeProcess = currentProcess
        const exitPromise = currentProcessExit.promise

        expectedProcessExit = true
        setStatus({
          lastError: undefined,
          pid: activeProcess.pid ?? null,
          state: 'stopping',
        })

        try {
          send('host.shutdown')

          const exited = await waitForProcessExit(exitPromise, options.exitTimeoutMs ?? 2_000)

          if (!exited) {
            activeProcess.kill()
            await exitPromise.catch(() => {})
          }
        }
        catch (error) {
          setStatus({
            lastError: errorMessageFrom(error) ?? `Failed to stop ${label}.`,
            pid: activeProcess.pid ?? null,
            state: 'error',
          })
          throw error
        }
        finally {
          await stopSocketRuntime()
        }

        setStatus({
          lastError: undefined,
          pid: null,
          state: 'stopped',
        })

        return currentStatus
      })
    },
    subscribe(callback) {
      const unsubscribe = statusListeners.subscribe(callback)
      callback(currentStatus)
      return unsubscribe
    },
  }
}

/** Publishes to each listener. A listener that throws does not stop the others. */
export function createListenerChannel<T>(onListenerError: (error: unknown) => void): ListenerChannel<T> {
  const listeners = new Set<(payload: T) => void>()

  return {
    publish(payload) {
      for (const listener of listeners) {
        try {
          listener(payload)
        }
        catch (error) {
          onListenerError(error)
        }
      }
    },
    subscribe(callback) {
      listeners.add(callback)

      return () => {
        listeners.delete(callback)
      }
    },
  }
}

/**
 * Validates the model of a renderer.
 *
 * @param invalidMessage The error for a payload that does not obey the schema.
 */
export function parseSceneInput(payload: unknown, invalidMessage: string): StageSidecarSceneInput {
  const result = safeParse(sceneInputPayloadSchema, payload)
  if (!result.success)
    throw new Error(invalidMessage)

  return result.output
}

/**
 * Writes bytes of a renderer to disk, for a sidecar to read by path.
 *
 * The directory comes from the caller. The file name comes from a renderer, so only its last part counts, and the file
 * cannot leave the directory.
 *
 * @returns the path of the file.
 */
export async function materializeFile(directory: string, fileName: string, data: Uint8Array) {
  const path = join(directory, normalizeFileName(fileName))

  await mkdir(directory, { recursive: true })
  await writeFile(path, data)

  return path
}

/** One file of a model package, by its path inside the package. */
export interface StageSidecarPackageFile {
  path: string
  data: Uint8Array
}

/**
 * Resolves a path inside a package to a path on disk.
 *
 * The path comes from a ZIP, which a stranger can write. So this function refuses each path that can leave `directory`,
 * and it never repairs one: a package with such a path is not a normal package.
 *
 * @example
 * resolvePackagePath('C:/models/a', 'tex\\face.png')
 * // => 'C:\\models\\a\\tex\\face.png'
 */
function resolvePackagePath(directory: string, path: string) {
  const normalized = path.replaceAll('\\', '/')
  const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.')
  const unsafe = normalized.startsWith('/')
    || segments.length === 0
    || segments.some(segment => segment === '..' || segment.includes(':') || segment.includes('\0'))

  if (unsafe)
    throw new Error(`The model package has an unsafe path: ${path}`)

  return join(directory, ...segments)
}

/**
 * Writes a model package to disk, for a sidecar that reads its textures by paths relative to the model.
 *
 * The check of all paths comes before the first write, so a refused package leaves nothing on disk. Files of an earlier
 * write stay in the directory, because a model ID always names the same package.
 *
 * @returns the path on disk of `modelPath`.
 */
export async function materializePackage(directory: string, files: StageSidecarPackageFile[], modelPath: string) {
  if (!files.some(file => file.path === modelPath))
    throw new Error(`The model package has no file at ${modelPath}`)

  const targets = files.map(file => ({ data: file.data, path: resolvePackagePath(directory, file.path) }))

  for (const target of targets) {
    await mkdir(dirname(target.path), { recursive: true })
    await writeFile(target.path, target.data)
  }

  return resolvePackagePath(directory, modelPath)
}

/**
 * Keeps the last part of a path, so a name from a renderer cannot leave its directory.
 *
 * @example
 * normalizeFileName('dir/model.vrm')
 * // => 'model.vrm'
 */
function normalizeFileName(fileName: string) {
  const normalized = basename(fileName.trim())
  return normalized || 'model.bin'
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return {
    promise,
    reject,
    resolve,
  }
}

function createInitialStatus(): ElectronStageSidecarStatus {
  return {
    pid: null,
    state: 'stopped',
    updatedAt: Date.now(),
  }
}

function createSocketEnvelope(type: string, payload?: unknown) {
  return JSON.stringify({ payload, type })
}

function getPayloadMessage(payload: unknown) {
  const result = safeParse(payloadMessageSchema, payload)
  if (!result.success) {
    return undefined
  }

  return result.output.message
}

function parseSocketMessage(message: WebSocketMessage): StageSidecarEnvelope {
  const parsed = safeDestr<unknown>(message.text(), { strict: true })
  const result = safeParse(socketEnvelopeSchema, parsed)
  if (!result.success)
    throw new Error('Invalid stage sidecar WebSocket envelope.')

  return result.output
}

function pipeProcessLog(stream: Readable, write: (message: string) => void) {
  stream.on('data', (data) => {
    const message = data.toString('utf-8').trim()
    if (message) {
      write(message)
    }
  })
}

function waitForProcessExit(exitPromise: Promise<void>, timeoutMs: number) {
  return Promise.race([
    exitPromise.then(() => true, () => false),
    new Promise<boolean>(resolve => setTimeout(resolve, timeoutMs, false)),
  ])
}
