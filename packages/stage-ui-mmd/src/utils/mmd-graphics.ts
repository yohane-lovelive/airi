import type { MMDRenderMode } from './mmd-pbr'

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
  /** Strength of the studio light that physically based materials reflect. Hybrid and PBR modes only. */
  environmentIntensity: number
  /** Strength of the light along the model edges, 0 to 1. Hybrid and PBR modes only. */
  rimIntensity: number
  /** Whether the model casts soft shadows on itself. Hybrid and PBR modes only. */
  shadows: boolean
  /** Strength of the contact shadows in creases, 0 to 1. High quality with hybrid or PBR only. */
  ambientOcclusion: number
  /** Blur of what lies in front of or behind the face, 0 to 1. 0 turns depth of field off. Medium and high only. */
  depthOfField: number
  /** Color fringes toward the edges of the view, as a lens makes them, 0 to 1. 0 turns them off. Medium and high only. */
  chromaticAberration: number
}

export const DEFAULT_MMD_GRAPHICS_ADJUSTMENTS: MMDGraphicsAdjustments = {
  toneMapping: 'neutral',
  exposure: 1,
  bloomIntensity: 0.6,
  bloomThreshold: 0.8,
  saturation: 0,
  contrast: 0,
  vignette: 0.3,
  environmentIntensity: 1,
  rimIntensity: 0.3,
  shadows: true,
  ambientOcclusion: 0.6,
  depthOfField: 0.5,
  chromaticAberration: 0.2,
}

/** What the scene shows, which decides the effects that make sense. */
export interface MMDGraphicsScene {
  /** The shading of the model. Ambient occlusion needs physically based shading. */
  renderMode?: MMDRenderMode
  /**
   * Whether a background image fills the view. Without one, the canvas is transparent and nothing lies behind the
   * model to blur. Depth of field would only spread the outline into a halo there, so it stays off.
   */
  hasBackground?: boolean
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
  ambientOcclusion?: {
    intensity: number
  }
  depthOfField?: {
    strength: number
    /** Resolution of the blur, relative to the canvas. */
    resolutionScale: number
  }
  chromaticAberration?: {
    strength: number
  }
}

/**
 * Turns a quality preset and the owner's adjustments into the effects to build.
 *
 * - `low`: tone mapping, SMAA, and a light bloom at half resolution.
 * - `medium`: adds color grading, the vignette, the full bloom strength, chromatic aberration, and, behind a background
 *   image, depth of field at half resolution.
 * - `high`: renders the bloom and the depth of field at full resolution and uses 4x multisampling instead of SMAA. With
 *   hybrid or PBR, it adds ambient occlusion. Toon shading has no place for it, so toon mode never gets it.
 *
 * @returns `undefined` for `off`, so the scene renders without post-processing.
 */
export function resolveMMDGraphics(
  quality: MMDGraphicsQuality,
  adjustments: MMDGraphicsAdjustments,
  { renderMode = 'toon', hasBackground = false }: MMDGraphicsScene = {},
): MMDGraphicsConfig | undefined {
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
    if (hasBackground && adjustments.depthOfField > 0)
      config.depthOfField = { strength: adjustments.depthOfField, resolutionScale: quality === 'high' ? 1 : 0.5 }
    if (adjustments.chromaticAberration > 0)
      config.chromaticAberration = { strength: adjustments.chromaticAberration }
  }
  if (quality === 'high' && renderMode !== 'toon' && adjustments.ambientOcclusion > 0)
    config.ambientOcclusion = { intensity: adjustments.ambientOcclusion }
  return config
}

/** The lights that physically based materials need. */
export interface MMDLightingConfig {
  environmentIntensity: number
  rimIntensity: number
  shadows: boolean
}

/**
 * Turns the render mode and the owner's adjustments into the lights for physically based materials.
 *
 * @returns `undefined` for toon mode. Toon materials ignore the environment light, and their look comes from the toon
 * map, so toon mode keeps the scene as it was.
 */
export function resolveMMDLighting(renderMode: MMDRenderMode, adjustments: MMDGraphicsAdjustments): MMDLightingConfig | undefined {
  if (renderMode === 'toon')
    return undefined
  return {
    environmentIntensity: adjustments.environmentIntensity,
    rimIntensity: adjustments.rimIntensity,
    shadows: adjustments.shadows,
  }
}
