/**
 * Graphics quality of the MMD scene. `off` renders as before, without post-processing.
 * Higher levels add effects and cost more GPU time, so each device chooses its own level.
 */
export type MMDGraphicsQuality = 'off' | 'low' | 'medium' | 'high'

/** Tone mapping of the post-processing. `neutral` keeps toon colors close to their source. */
export type MMDToneMapping = 'neutral' | 'agx' | 'aces'

/** The values that the owner adjusts on top of a quality preset. */
export interface MMDGraphicsAdjustments {
  toneMapping: MMDToneMapping
  /** Brightness before tone mapping. 1 keeps the source. */
  exposure: number
  /** Bloom strength. 0 turns bloom off. */
  bloomIntensity: number
  /** Luminance, 0 to 1, above which a pixel glows. */
  bloomThreshold: number
  /** -1 to 1. 0 keeps the source. */
  saturation: number
  /** -1 to 1. 0 keeps the source. */
  contrast: number
  /** Darkness of the corners, 0 to 1. 0 turns the vignette off. */
  vignette: number
}

export const DEFAULT_MMD_GRAPHICS_ADJUSTMENTS: MMDGraphicsAdjustments = {
  toneMapping: 'neutral',
  exposure: 1,
  bloomIntensity: 0.6,
  bloomThreshold: 0.8,
  saturation: 0,
  contrast: 0,
  vignette: 0.3,
}

/** The effects that the post-processing builds. An effect that is missing stays off. */
export interface MMDGraphicsConfig {
  toneMapping: MMDToneMapping
  exposure: number
  /** Samples of the render target. 0 uses SMAA instead. */
  multisampling: number
  smaa: boolean
  bloom?: {
    intensity: number
    threshold: number
    /** Resolution of the bloom blur, relative to the canvas. */
    resolutionScale: number
  }
  color?: {
    saturation: number
    contrast: number
  }
  vignette?: {
    darkness: number
  }
}

/**
 * Turns a quality preset and the owner's adjustments into the effects to build.
 *
 * - `low`: tone mapping, SMAA, and a light bloom at half resolution.
 * - `medium`: adds color grading, the vignette, and the full bloom strength.
 * - `high`: renders the bloom at full resolution and uses 4x multisampling instead of SMAA.
 *
 * @returns `undefined` for `off`, so the scene renders without post-processing.
 */
export function resolveMMDGraphics(quality: MMDGraphicsQuality, adjustments: MMDGraphicsAdjustments): MMDGraphicsConfig | undefined {
  if (quality === 'off')
    return undefined

  const bloomIntensity = quality === 'low' ? adjustments.bloomIntensity * 0.5 : adjustments.bloomIntensity
  const config: MMDGraphicsConfig = {
    toneMapping: adjustments.toneMapping,
    exposure: adjustments.exposure,
    multisampling: quality === 'high' ? 4 : 0,
    smaa: quality !== 'high',
  }
  if (bloomIntensity > 0) {
    config.bloom = {
      intensity: bloomIntensity,
      threshold: adjustments.bloomThreshold,
      resolutionScale: quality === 'high' ? 1 : 0.5,
    }
  }
  if (quality !== 'low') {
    if (adjustments.saturation !== 0 || adjustments.contrast !== 0)
      config.color = { saturation: adjustments.saturation, contrast: adjustments.contrast }
    if (adjustments.vignette > 0)
      config.vignette = { darkness: adjustments.vignette }
  }
  return config
}
