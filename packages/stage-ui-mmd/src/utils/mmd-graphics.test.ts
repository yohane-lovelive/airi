import { describe, expect, it } from 'vitest'

import { DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, resolveMMDGraphics, resolveMMDLighting } from './mmd-graphics'

describe('resolveMMDGraphics', () => {
  it('turns post-processing off for the off preset', () => {
    expect(resolveMMDGraphics('off', DEFAULT_MMD_GRAPHICS_ADJUSTMENTS)).toBeUndefined()
  })

  it('gives the low preset tone mapping, SMAA, and a light half-resolution bloom only', () => {
    const config = resolveMMDGraphics('low', { ...DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, saturation: 0.5 })

    expect(config).toEqual({
      toneMapping: 'neutral',
      exposure: 1,
      multisampling: 0,
      smaa: true,
      bloom: { intensity: 0.3, threshold: 0.8, resolutionScale: 0.5 },
    })
  })

  it('adds color grading and the vignette from the medium preset', () => {
    const config = resolveMMDGraphics('medium', { ...DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, saturation: 0.2, contrast: 0.1 })

    expect(config?.bloom).toEqual({ intensity: 0.6, threshold: 0.8, resolutionScale: 0.5 })
    expect(config?.color).toEqual({ saturation: 0.2, contrast: 0.1 })
    expect(config?.vignette).toEqual({ darkness: 0.3 })
  })

  it('uses full-resolution bloom and multisampling instead of SMAA for the high preset', () => {
    const config = resolveMMDGraphics('high', DEFAULT_MMD_GRAPHICS_ADJUSTMENTS)

    expect(config?.multisampling).toBe(4)
    expect(config?.smaa).toBe(false)
    expect(config?.bloom?.resolutionScale).toBe(1)
  })

  it('leaves out effects that the adjustments turn off', () => {
    const config = resolveMMDGraphics('medium', { ...DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, bloomIntensity: 0, vignette: 0 })

    expect(config?.bloom).toBeUndefined()
    expect(config?.vignette).toBeUndefined()
    expect(config?.color).toBeUndefined()
  })
})

describe('resolveMMDGraphics ambient occlusion', () => {
  it('adds ambient occlusion only to the high preset with physical shading', () => {
    expect(resolveMMDGraphics('high', DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, { renderMode: 'hybrid' })?.ambientOcclusion).toEqual({ intensity: 0.6 })
    expect(resolveMMDGraphics('high', DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, { renderMode: 'toon' })?.ambientOcclusion).toBeUndefined()
    expect(resolveMMDGraphics('medium', DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, { renderMode: 'pbr' })?.ambientOcclusion).toBeUndefined()
  })
})

describe('resolveMMDGraphics lens effects', () => {
  it('adds depth of field and chromatic aberration from the medium preset', () => {
    expect(resolveMMDGraphics('low', DEFAULT_MMD_GRAPHICS_ADJUSTMENTS)?.depthOfField).toBeUndefined()
    expect(resolveMMDGraphics('low', DEFAULT_MMD_GRAPHICS_ADJUSTMENTS)?.chromaticAberration).toBeUndefined()

    const medium = resolveMMDGraphics('medium', DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, { hasBackground: true })
    expect(medium?.depthOfField).toEqual({ strength: 0.5, resolutionScale: 0.5 })
    expect(medium?.chromaticAberration).toEqual({ strength: 0.2 })
  })

  it('blurs at full resolution for the high preset', () => {
    expect(resolveMMDGraphics('high', DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, { hasBackground: true })?.depthOfField?.resolutionScale).toBe(1)
  })

  // ROOT CAUSE:
  //
  // On a transparent canvas, the background counts as far away, so depth of field blurred the model outline outward.
  // The model got a hazy halo, and nothing behind it was there to blur.
  //
  // We fixed this by keeping depth of field off without a background image.
  it('leaves depth of field out on a transparent canvas', () => {
    const config = resolveMMDGraphics('high', DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, { hasBackground: false })

    expect(config?.depthOfField).toBeUndefined()
    expect(config?.chromaticAberration).toEqual({ strength: 0.2 })
  })

  it('leaves the lens effects out at strength 0', () => {
    const config = resolveMMDGraphics('high', { ...DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, depthOfField: 0, chromaticAberration: 0 }, { hasBackground: true })

    expect(config?.depthOfField).toBeUndefined()
    expect(config?.chromaticAberration).toBeUndefined()
  })
})

describe('resolveMMDLighting', () => {
  it('adds no lights in toon mode', () => {
    expect(resolveMMDLighting('toon', DEFAULT_MMD_GRAPHICS_ADJUSTMENTS)).toBeUndefined()
  })

  it('reads the light adjustments in hybrid and PBR modes', () => {
    expect(resolveMMDLighting('pbr', { ...DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, shadows: false })).toEqual({
      environmentIntensity: 1,
      rimIntensity: 0.3,
      shadows: false,
    })
  })
})
