/**
 * A display sidecar without an engine. It obeys the WebSocket protocol, so tests and live checks can verify the Electron
 * side without Godot or Unity.
 *
 * Use when:
 * - A test of `services/airi/stage-sidecar` needs a real child process and a real socket.
 * - A developer checks the signals of the real app, with `AIRI_UNITY_STAGE_ATTACH=1`:
 *   `node scripts/fake-stage-sidecar.mjs --attach=<userData>/unity-stage/attach.json`
 *
 * Environment:
 * - `FAKE_SIDECAR_MODE`: `normal` (default), `fatal`, `crash`, `no-ready`, `ignore-shutdown`, `slow-exit`.
 * - `FAKE_SIDECAR_LOG`: a file. Each received message gets one JSON line. Without it, this script prints to stdout.
 * - `FAKE_SIDECAR_EXIT_DELAY_MS`: in `slow-exit` mode, the time from `host.shutdown` to the exit. Just before the exit,
 *   the log gets the line `{"type":"fake.exit"}`, so a test can tell an exit from a kill.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { argv, env, exit } from 'node:process'

const mode = env.FAKE_SIDECAR_MODE ?? 'normal'
const logPath = env.FAKE_SIDECAR_LOG

function argumentValue(name) {
  return argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
}

function resolveUrl() {
  const attachPath = argumentValue('attach')
  if (attachPath)
    return JSON.parse(readFileSync(attachPath, 'utf8')).url

  return argumentValue('airi-ws-url')
}

const url = resolveUrl()
if (!url) {
  console.error('fake-stage-sidecar: pass --airi-ws-url=<url> or --attach=<file>')
  exit(2)
}

const socket = new WebSocket(url)
const counts = new Map()

function send(type, payload) {
  socket.send(JSON.stringify({ type, payload }))
}

function record(message) {
  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify(message)}\n`)
    return
  }

  // A live check gets 30 frames each second, so only the first frame of each second prints.
  const count = (counts.get(message.type) ?? 0) + 1
  counts.set(message.type, count)
  if (message.type !== 'host.character.frame' || count % 30 === 1)
    console.info(`[${count}] ${JSON.stringify(message)}`)
}

function answer(message) {
  switch (message.type) {
    case 'host.scene.apply': {
      if (message.payload.path.includes('broken')) {
        send('scene.error', { message: 'The file is broken.' })
        return
      }
      send('scene.applied', {
        modelId: message.payload.modelId,
        avatarBounds: {
          center: { x: 0, y: 0.75, z: 0 },
          size: { x: 0.5, y: 1.5, z: 0.25 },
          maxDimension: 1.5,
        },
      })
      return
    }
    // The Godot view state. The Unity protocol has no such messages.
    case 'host.view.patch':
    case 'host.view.request_snapshot': {
      send('stage.view.snapshot', {
        state: {
          schemaVersion: 1,
          revision: 1,
          updatedAt: 1,
          camera: { position: { x: 0, y: 1, z: 2 }, yawDeg: 0, pitchDeg: 0, fovDeg: 40 },
        },
        reason: message.type === 'host.view.patch' ? 'remote-patch' : 'request',
        requestId: message.payload.requestId,
      })
      return
    }
    case 'host.shutdown': {
      if (mode === 'slow-exit') {
        setTimeout(() => {
          record({ type: 'fake.exit' })
          exit(0)
        }, Number(env.FAKE_SIDECAR_EXIT_DELAY_MS ?? 0))
      }
      else if (mode !== 'ignore-shutdown') {
        socket.close()
        exit(0)
      }
    }
  }
}

socket.addEventListener('open', () => {
  if (mode === 'crash')
    exit(3)

  if (mode === 'fatal')
    send('stage.fatal', { message: 'The fake sidecar failed by request.' })
  else if (mode !== 'no-ready')
    send('stage.ready')
})

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  record(message)
  answer(message)
})

socket.addEventListener('close', () => {
  // A real sidecar exits when it loses the host, so a test cannot leave this process behind.
  exit(0)
})
