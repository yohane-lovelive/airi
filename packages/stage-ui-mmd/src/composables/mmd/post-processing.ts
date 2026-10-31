import type { Camera, Scene, WebGLRenderer } from 'three'

import type { MMDGraphicsConfig, MMDToneMapping } from '../../utils/mmd-graphics'

import {
  BloomEffect,
  BrightnessContrastEffect,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing'
import { HalfFloatType } from 'three'

const TONE_MAPPING_MODE: Record<MMDToneMapping, ToneMappingMode> = {
  neutral: ToneMappingMode.NEUTRAL,
  agx: ToneMappingMode.AGX,
  aces: ToneMappingMode.ACES_FILMIC,
}

/**
 * Renders the MMD scene through post-processing: bloom, tone mapping, color grading, the vignette, and anti-aliasing.
 *
 * State model:
 * - The composer renders into half-float targets, so bright pixels keep their value until tone mapping.
 * - `apply` rebuilds the passes for a new configuration. The effects run in one pass, then SMAA runs in its own pass,
 *   because SMAA reads neighbor pixels.
 * - The alpha channel survives. On a transparent window, bloom adds light where the alpha is 0, and the premultiplied
 *   canvas shows it as a glow over the desktop.
 *
 * Use when:
 * - The owner chose a graphics quality other than `off`. Otherwise the scene renders directly.
 */
export class MMDPostProcessing {
  private readonly composer: EffectComposer
  private readonly disposables: Array<{ dispose: () => void }> = []

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly camera: Camera,
  ) {
    this.composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType })
  }

  /** Builds the passes for a configuration. Call it again after the configuration changes. */
  apply(config: MMDGraphicsConfig) {
    this.clearPasses()
    this.composer.multisampling = config.multisampling
    // Built-in tone mapping functions read the renderer exposure. Materials stay untoned, because the
    // renderer keeps `NoToneMapping`.
    this.renderer.toneMappingExposure = config.exposure

    const effects = []
    if (config.bloom) {
      effects.push(new BloomEffect({
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

    this.addPass(new RenderPass(this.scene, this.camera))
    this.addPass(new EffectPass(this.camera, ...effects))
    if (config.smaa)
      this.addPass(new EffectPass(this.camera, new SMAAEffect()))
  }

  setSize(width: number, height: number) {
    this.composer.setSize(width, height, false)
  }

  render(delta: number) {
    this.composer.render(delta)
  }

  dispose() {
    this.clearPasses()
    this.composer.dispose()
    this.renderer.toneMappingExposure = 1
  }

  private addPass(pass: RenderPass | EffectPass) {
    this.composer.addPass(pass)
    this.disposables.push(pass)
  }

  private clearPasses() {
    this.composer.removeAllPasses()
    for (const pass of this.disposables.splice(0))
      pass.dispose()
  }
}
