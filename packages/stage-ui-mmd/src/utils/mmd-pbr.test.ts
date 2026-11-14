import { describe, expect, it } from 'vitest'

import { applyMMDSurfaceOverride, classifyMMDMaterial, MMD_SURFACE_DEFAULTS, resolveMMDSurface, usesPhysicalMaterial } from './mmd-pbr'

describe('classifyMMDMaterial', () => {
  it.each([
    ['前髪', 'hair'],
    ['ｽｶｰﾄ', 'cloth'],
    ['白目', 'eye'],
    ['顔', 'face'],
    ['肌', 'skin'],
    ['ベルト金具', 'metal'],
    ['ラテックス手袋', 'leather'],
    ['Hair_back', 'hair'],
  ] as const)('reads %s as %s', (name, kind) => {
    expect(classifyMMDMaterial({ name })).toBe(kind)
  })

  it('reads romaji texture file names that PMD models use as material names', () => {
    expect(classifyMMDMaterial({ name: 'kami.bmp*sp_k.spa' })).toBe('hair')
    expect(classifyMMDMaterial({ name: 'huku3.bmp' })).toBe('cloth')
    expect(classifyMMDMaterial({ name: 'me.bmp' })).toBe('eye')
    expect(classifyMMDMaterial({ name: '', textureFileName: 'hoho.png' })).toBe('face')
  })

  it('matches a short romaji word only as a whole word', () => {
    expect(classifyMMDMaterial({ name: 'metal_plate' })).toBe('metal')
    expect(classifyMMDMaterial({ name: 'memo' })).toBe('other')
  })

  // ROOT CAUSE:
  //
  // In Lat-style Miku, the face skin is named after a shared texture, `huku3w.bmp`, so the name said cloth. Hybrid mode
  // shaded the face as PBR, and the face showed gray patches.
  //
  // We fixed this by treating a material that mostly follows the head bone as the face.
  it('makes a material that mostly follows the head bone the face', () => {
    expect(classifyMMDMaterial({ name: 'huku3w.bmp', headShare: 1 })).toBe('face')
    expect(classifyMMDMaterial({ name: '', headShare: 0.9 })).toBe('face')
    expect(classifyMMDMaterial({ name: '', headShare: 0.2 })).toBe('other')
  })

  it('keeps hair and eyes on the head as they are', () => {
    expect(classifyMMDMaterial({ name: '前髪', headShare: 0.9 })).toBe('hair')
    expect(classifyMMDMaterial({ name: '瞳', headShare: 1 })).toBe('eye')
  })
})

describe('resolveMMDSurface', () => {
  it('gives the defaults of the guessed kind', () => {
    expect(resolveMMDSurface({ name: '髪' })).toEqual({ ...MMD_SURFACE_DEFAULTS.hair, kind: 'hair' })
  })

  it('applies the owner kind first, then the owner values', () => {
    expect(resolveMMDSurface({ name: '髪' }, { kind: 'metal', roughness: 0.1 }))
      .toEqual({ ...MMD_SURFACE_DEFAULTS.metal, roughness: 0.1, kind: 'metal' })
  })

  it('keeps the guessed kind when the owner changes only values', () => {
    expect(applyMMDSurfaceOverride('cloth', { sheen: 0 })).toEqual({ ...MMD_SURFACE_DEFAULTS.cloth, sheen: 0, kind: 'cloth' })
  })
})

describe('usesPhysicalMaterial', () => {
  it('keeps every material toon in toon mode', () => {
    expect(usesPhysicalMaterial('toon', 'hair')).toBe(false)
  })

  it('keeps faces and eyes toon in hybrid mode', () => {
    expect(usesPhysicalMaterial('hybrid', 'face')).toBe(false)
    expect(usesPhysicalMaterial('hybrid', 'eye')).toBe(false)
    expect(usesPhysicalMaterial('hybrid', 'cloth')).toBe(true)
  })

  it('makes every material physical in PBR mode', () => {
    expect(usesPhysicalMaterial('pbr', 'face')).toBe(true)
  })
})
