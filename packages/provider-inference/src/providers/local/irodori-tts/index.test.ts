import type { SpeechProvider } from '@xsai-ext/providers/utils'

import type { IrodoriTtsConfig } from '.'
import type { ProviderTranslator } from '../../../types'

import { generateSpeech } from '@xsai/generate-speech'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { irodoriClipIdFor, irodoriReferenceSeconds, isIrodoriClipFile, moveIrodoriClip, providerIrodoriTts, uploadIrodoriClip } from '.'

const translate: ProviderTranslator = key => key

interface ServerCall {
  init: RequestInit
  url: URL
}

/** Answers the server endpoints over the ambient `fetch` the provider calls. */
function installServer(): ServerCall[] {
  const calls: ServerCall[] = []

  vi.stubGlobal('fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ init: init ?? {}, url })

    if (url.pathname === '/v1/audio/voices' && (init?.method ?? 'GET') === 'GET') {
      return Response.json({
        data: [
          { id: 'airi-mio-b', ref_wav: 'voices\\airi-mio-b.wav' },
          { id: 'airi-mio-a', ref_wav: 'voices\\airi-mio-a.flac' },
          { id: 'alice', ref_wav: 'voices\\alice.wav' },
          { id: 'none', no_ref: true, ref_wav: null },
        ],
        object: 'list',
      })
    }
    if (url.pathname === '/v1/audio/speech')
      return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { 'Content-Type': 'audio/wav' } })
    if (url.pathname === '/v1/audio/voices')
      return Response.json({ id: 'airi-mio-c', object: 'voice_file' }, { status: 201 })

    throw new Error(`unexpected endpoint ${url.pathname}`)
  })

  return calls
}

const config: IrodoriTtsConfig = {
  baseUrl: 'http://localhost:8088/v1/',
  referenceVoices: [{
    clips: [
      { id: 'airi-mio-a', name: 'first.flac', seconds: 6 },
      { id: 'airi-mio-b', name: 'second.wav', seconds: 8 },
    ],
    id: 'mio',
    name: 'Mio',
  }],
  voiceSettings: { caption: '  明るい少女  ', numSteps: 24, speed: 1.1 },
}

async function speak(voice: string, overrides: Partial<IrodoriTtsConfig> = {}) {
  const provider = await providerIrodoriTts.createProvider({ ...config, ...overrides }) as SpeechProvider
  return await generateSpeech({ ...provider.speech('irodori-tts'), input: 'こんにちは', voice })
}

function speechBody(calls: ServerCall[]) {
  const call = calls.find(item => item.url.pathname === '/v1/audio/speech')
  return JSON.parse(call!.init.body as string) as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('irodori-tts provider', () => {
  it('ships the documented server address', async () => {
    const defaults = z.parse(await providerIrodoriTts.createProviderConfig({ t: translate }), {})

    expect(defaults.baseUrl).toBe('http://localhost:8088/v1/')
    expect(defaults.voiceSettings).toEqual({ caption: '', numSteps: 0, speed: 1 })
  })

  it('sends the clips of a reference voice as server paths in the order of the voice', async () => {
    const calls = installServer()

    await speak('reference:mio')

    expect(speechBody(calls)).toEqual({
      input: 'こんにちは',
      irodori: { caption: '明るい少女', num_steps: 24, ref_wavs: ['voices\\airi-mio-a.flac', 'voices\\airi-mio-b.wav'] },
      model: 'irodori-tts',
      response_format: 'wav',
      speed: 1.1,
    })
  })

  it('passes a server voice as it is, and leaves out an empty caption and the server step default', async () => {
    const calls = installServer()

    await speak('alice', { voiceSettings: { caption: ' ', numSteps: 0, speed: 1 } })

    expect(speechBody(calls)).toEqual({ input: 'こんにちは', irodori: {}, model: 'irodori-tts', response_format: 'wav', speed: 1, voice: 'alice' })
    expect(calls.some(call => call.url.pathname === '/v1/audio/voices')).toBe(false)
  })

  it('names a clip that the server no longer has', async () => {
    installServer()

    await expect(speak('reference:mio', {
      referenceVoices: [{ clips: [{ id: 'airi-mio-gone', name: 'gone.wav', seconds: 3 }], id: 'mio', name: 'Mio' }],
    })).rejects.toThrow('airi-mio-gone')
  })

  it('lists the reference voices first, and hides the uploaded clips', async () => {
    installServer()

    const voices = await providerIrodoriTts.extraMethods!.listVoices!(config, {} as never)

    expect(voices.map(voice => voice.id)).toEqual(['reference:mio', 'alice', 'none'])
    expect(voices[0].name).toBe('Mio')
  })

  it('uploads a clip with its voice id and its file name, and sends the key', async () => {
    const calls = installServer()

    await uploadIrodoriClip({ apiKey: 'secret', baseUrl: 'http://localhost:8088/v1/' }, 'airi-mio-c', new Blob([new Uint8Array([1])]), 'third.ogg')

    const form = calls[0].init.body as FormData
    expect(calls[0].init.method).toBe('POST')
    expect(form.get('voice_id')).toBe('airi-mio-c')
    expect((form.get('file') as File).name).toBe('third.ogg')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer secret')
  })
})

describe('irodori-tts reference voice helpers', () => {
  it('builds a clip id that the server accepts', () => {
    expect(irodoriClipIdFor('mio', 'x1Y_2')).toBe('airi-mio-x1Y_2')
    expect(irodoriClipIdFor('mi o', 'a.b')).toBe('airi-mi_o-a_b')
  })

  it('accepts only the extensions that the server accepts', () => {
    expect(isIrodoriClipFile('Voice.WAV')).toBe(true)
    expect(isIrodoriClipFile('voice.ogg')).toBe(true)
    expect(isIrodoriClipFile('voice.txt')).toBe(false)
  })

  it('moves a clip and keeps the order when the move passes an end', () => {
    expect(moveIrodoriClip(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b'])
    expect(moveIrodoriClip(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    expect(moveIrodoriClip(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
  })

  it('adds the lengths of the clips', () => {
    expect(irodoriReferenceSeconds([{ seconds: 6.5 }, { seconds: 8 }, {}])).toBe(14.5)
  })
})
