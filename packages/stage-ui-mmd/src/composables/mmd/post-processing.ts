import type { BloomEffectOptions } from 'postprocessing'
import type { Camera, Scene, WebGLRenderer } from 'three'

import type { MMDGraphicsConfig, MMDToneMapping } from '../../utils/mmd-graphics'

import {
  BloomEffect,
  BrightnessContrastEffect,
  ChromaticAberrationEffect,
  DepthOfFieldEffect,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  NormalPass,
  RenderPass,
  SMAAEffect,
  SSAOEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing'
import { HalfFloatType, Vector2, Vector3 } from 'three'

const TONE_MAPPING_MODE: Record<MMDToneMapping, ToneMappingMode> = {
  neutral: ToneMappingMode.NEUTRAL,
  agx: ToneMappingMode.AGX,
  aces: ToneMappingMode.ACES_FILMIC,
}

/** Bokeh size at depth of field strength 1. The library default is 1. */
const MAX_BOKEH_SCALE = 3
/** Color offset at the edges of the view at chromatic aberration strength 1, relative to the view size. */
const MAX_CHROMATIC_OFFSET = 0.004

/** The bloom shader of the library, with an output alpha of 0. */
const LIGHT_ONLY_BLOOM_SHADER = `#ifdef FRAMEBUFFER_PRECISION_HIGH
uniform mediump sampler2D map;
#else
uniform lowp sampler2D map;
#endif
uniform float intensity;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = vec4(texture2D(map, uv).rgb * intensity, 0.0);
}`

/** Bloom that adds light only, and keeps the alpha of the scene. */
class LightOnlyBloomEffect extends BloomEffect {
  constructor(options: BloomEffectOptions) {
    super(options)
    // NOTICE:
    // A transparent window showed a dark, flickering haze around the model.
    // The library bloom blurs the alpha with the colors, and its blend keeps the larger alpha.
    // Source: `bloom.frag` and the blend functions in `node_modules/postprocessing/build/index.js` (6.39.4).
    // Remove it when the library bloom keeps the alpha of its input.
    this.setFragmentShader(LIGHT_ONLY_BLOOM_SHADER)
  }
}

/**
 * Renders the MMD scene through post-processing: ambient occlusion, depth of field, bloom, tone mapping, color grading,
 * the vignette, chromatic aberration, and anti-aliasing.
 *
 * State model:
 * - The composer renders into half-float targets, so bright pixels keep their value until tone mapping.
 * - `apply` rebuilds the passes for a new configuration. The effects run in one pass. Chromatic aberration and SMAA
 *   each run in a pass of their own, because they read neighbor pixels. Ambient occlusion also needs a normal pass,
 *   which renders the scene again.
 * - Depth of field keeps the focus that `setFocus` sets. The focus survives a rebuild.
 * - The alpha channel survives. On a transparent window, bloom adds light where the alpha is 0, and the premultiplied
 *   canvas shows it as a glow over the desktop.
 *
 * Use when:
 * - The owner chose a graphics quality other than `off`. Otherwise the scene renders directly.
 */
export class MMDPostProcessing {
  private readonly composer: EffectComposer
  private readonly disposables: Array<{ dispose: () => void }> = []
  /** Renderer settings that the composer changes. `dispose` restores them for direct rendering. */
  private readonly rendererState: { autoClear: boolean, toneMappingExposure: number }
  /** The point that depth of field keeps sharp. Depth of field reads it every frame. */
  private readonly focusTarget = new Vector3()
  /** The depth around the focus point that stays sharp, in world units. */
  private focusRange = 1
  private depthOfField: DepthOfFieldEffect | undefined

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly camera: Camera,
  ) {
    this.rendererState = { autoClear: renderer.autoClear, toneMappingExposure: renderer.toneMappingExposure }
    // The composer turns `autoClear` off, because its passes clear their own targets.
    this.composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType })
  }

  /** Builds the passes for a configuration. Call it again after the configuration changes. */
  apply(config: MMDGraphicsConfig) {
    this.clearPasses()
    this.composer.multisampling = config.multisampling
    // Built-in tone mapping functions read the renderer exposure. Materials stay untoned, because the
    // renderer keeps `NoToneMapping`.
    this.renderer.toneMappingExposure = config.exposure

    this.addPass(new RenderPass(this.scene, this.camera))

    const effects = []
    if (config.ambientOcclusion) {
      const normalPass = new NormalPass(this.scene, this.camera)
      this.addPass(normalPass)
      // Ambient occlusion darkens the linear light, so it comes before bloom and tone mapping.
      effects.push(new SSAOEffect(this.camera, normalPass.texture, {
        intensity: config.ambientOcclusion.intensity,
        luminanceInfluence: 0.95,
        radius: 0.03,
        samples: 16,
        rings: 7,
        resolutionScale: 0.5,
      }))
    }
    this.depthOfField = undefined
    if (config.depthOfField) {
      this.depthOfField = new DepthOfFieldEffect(this.camera, {
        focusRange: this.focusRange,
        bokehScale: config.depthOfField.strength * MAX_BOKEH_SCALE,
        resolutionScale: config.depthOfField.resolutionScale,
      })
      this.depthOfField.target = this.focusTarget
      effects.push(this.depthOfField)
    }
    if (config.bloom) {
      effects.push(new LightOnlyBloomEffect({
        intensity: config.bloom.intensity,
        luminanceThreshold: config.bloom.threshold,
        luminanceSmoothing: 0.1,
        mipmapBlur: true,
        resolutionScale: config.bloom.resolutionScale,
      }))
    }
    effects.push(new ToneMappingEffect({ mode: TONE_MAPPING_MODE[config.toneMapping] }))
    if (config.color) {
      effects.push(new HueSaturationEffect({ saturation: config.color.saturation }))
      effects.push(new BrightnessContrastEffect({ contrast: config.color.contrast }))
    }
    if (config.vignette)
      effects.push(new VignetteEffect({ darkness: config.vignette.darkness, offset: 0.35 }))

    this.addPass(new EffectPass(this.camera, ...effects))
    if (config.chromaticAberration) {
      const offset = config.chromaticAberration.strength * MAX_CHROMATIC_OFFSET
      this.addPass(new EffectPass(this.camera, new ChromaticAberrationEffect({
        offset: new Vector2(offset, offset),
        // Stronger toward the edges of the view, as a lens makes it, so the face in the middle stays clean.
        radialModulation: true,
        modulationOffset: 0.3,
      })))
    }
    if (config.smaa)
      this.addPass(new EffectPass(this.camera, new SMAAEffect()))
  }

  /**
   * Sets what depth of field keeps sharp. Call it every frame while the subject moves.
   *
   * @param target The point in focus, in world space.
   * @param range The depth around the point that stays sharp, in world units.
   */
  setFocus(target: Vector3, range: number) {
    this.focusTarget.copy(target)
    this.focusRange = range
    if (this.depthOfField)
      this.depthOfField.cocMaterial.focusRange = range
  }

  setSize(width: number, height: number) {
    this.composer.setSize(width, height, false)
  }

  render(delta: number) {
    this.composer.render(delta)
  }

  /** Frees the passes and restores the renderer. Without the restore, direct rendering never cleared and left trails. */
  dispose() {
    this.clearPasses()
    this.composer.dispose()
    this.renderer.autoClear = this.rendererState.autoClear
    this.renderer.toneMappingExposure = this.rendererState.toneMappingExposure
  }

  private addPass(pass: RenderPass | NormalPass | EffectPass) {
    this.composer.addPass(pass)
    this.disposables.push(pass)
  }

  private clearPasses() {
    this.composer.removeAllPasses()
    for (const pass of this.disposables.splice(0))
      pass.dispose()
  }
}
