import { describe, expect, it } from 'vitest'

import { defaultConfig, generateBody, localDayOf, normalizeLoopbackUrl, resolveConfigUpdate, serviceUrl, toRequestError, toVrmaBytes, usedOn } from './request'

describe('normalizeLoopbackUrl', () => {
  it('accepts an address of this PC, and drops trailing slashes', () => {
    expect(normalizeLoopbackUrl(' http://127.0.0.1:8787/ ')).toBe('http://127.0.0.1:8787')
    expect(normalizeLoopbackUrl('http://localhost:9000')).toBe('http://localhost:9000')
    expect(normalizeLoopbackUrl('http://[::1]:8787')).toBe('http://[::1]:8787')
  })

  it('refuses another host, which would get the token', () => {
    expect(() => normalizeLoopbackUrl('http://192.168.1.20:8787')).toThrow('must run on this PC')
    expect(() => normalizeLoopbackUrl('https://example.com')).toThrow('must run on this PC')
    expect(() => normalizeLoopbackUrl('http://127.0.0.1.example.com:8787')).toThrow('must run on this PC')
  })

  it('refuses another scheme, a path, and a value that is not a URL', () => {
    expect(() => normalizeLoopbackUrl('file:///C:/x')).toThrow('must start with http:// or https://')
    expect(() => normalizeLoopbackUrl('http://127.0.0.1:8787/v1')).toThrow('without a path')
    expect(() => normalizeLoopbackUrl('127.0.0.1:8787')).toThrow()
  })
})

describe('resolveConfigUpdate', () => {
  const stored = { ...defaultConfig, token: 'secret' }

  it('keeps an absent field, and clears the token with an empty string', () => {
    expect(resolveConfigUpdate(stored, { enabled: true })).toEqual({ ...stored, enabled: true })
    expect(resolveConfigUpdate(stored, { token: '' }).token).toBe('')
    expect(resolveConfigUpdate(stored, { token: ' next ' }).token).toBe('next')
  })

  it('keeps the token when the port changes, because every address is on this PC', () => {
    expect(resolveConfigUpdate(stored, { baseUrl: 'http://127.0.0.1:9000' })).toMatchObject({ baseUrl: 'http://127.0.0.1:9000', token: 'secret' })
  })

  it('keeps the daily limit between 1 and 50', () => {
    expect(resolveConfigUpdate(stored, { dailyLimit: 0 }).dailyLimit).toBe(1)
    expect(resolveConfigUpdate(stored, { dailyLimit: 3.6 }).dailyLimit).toBe(4)
    expect(resolveConfigUpdate(stored, { dailyLimit: 500 }).dailyLimit).toBe(50)
  })
})

describe('the count of a day', () => {
  it('counts the generations of today only', () => {
    const day = localDayOf(new Date(2026, 10, 4, 23, 59))
    expect(day).toBe('2026-11-04')
    const stored = { ...defaultConfig, usedDay: day, usedCount: 3 }
    expect(usedOn(stored, day)).toBe(3)
    expect(usedOn(stored, '2026-11-05')).toBe(0)
  })
})

describe('generateBody', () => {
  it('asks ARDY without a planner, so no key of another service is needed', () => {
    expect(generateBody({ prompt: ' swing a sword ' })).toEqual({ prompt: 'swing a sword', engine: 'ardy', planner: 'none', duration: 3, format: 'vrma' })
  })

  it('keeps the duration between 1 and 8 seconds, and the prompt short', () => {
    expect(generateBody({ prompt: 'x', duration: 0.2 }).duration).toBe(1)
    expect(generateBody({ prompt: 'x', duration: 30 }).duration).toBe(8)
    expect(generateBody({ prompt: 'a'.repeat(500) }).prompt).toHaveLength(200)
    expect(() => generateBody({ prompt: '  ' })).toThrow('Describe the motion')
  })
})

describe('responses', () => {
  it('builds the URL under the stored address', () => {
    expect(serviceUrl('http://127.0.0.1:8787', '/v1/motions')).toBe('http://127.0.0.1:8787/v1/motions')
  })

  it('accepts a binary glTF file only', () => {
    const glb = new Uint8Array([0x67, 0x6C, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0])
    expect(toVrmaBytes(glb.buffer)).toEqual(glb)
    expect(() => toVrmaBytes(new TextEncoder().encode('{"name":"spec"}').buffer)).toThrow('no .vrma file')
  })

  it('keeps the reason of the service in the error', async () => {
    const error = await toRequestError(new Response('invalid token', { status: 401 }))
    expect(error.message).toBe('The motion generator answered 401: invalid token')
  })
})
