import { PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, resolveMMDGraphics } from '../../utils/mmd-graphics'
import { MMDPostProcessing } from './post-processing'

describe('mMDPostProcessing', () => {
  const renderers: WebGLRenderer[] = []

  afterEach(() => {
    for (const renderer of renderers.splice(0))
      renderer.dispose()
  })

  // ROOT CAUSE:
  //
  // The composer turns `renderer.autoClear` off. After the owner turned effects off, the scene rendered directly
  // without a clear, so earlier frames stayed on the canvas as trails.
  //
  // We fixed this by restoring the renderer settings in `dispose`.
  it('restores the renderer settings when it is disposed', () => {
    const renderer = new WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true })
    renderers.push(renderer)
    renderer.setSize(64, 64, false)

    const postProcessing = new MMDPostProcessing(renderer, new Scene(), new PerspectiveCamera())
    postProcessing.apply(resolveMMDGraphics('medium', { ...DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, exposure: 1.4 })!)
    postProcessing.render(0)
    expect(renderer.autoClear).toBe(false)
    expect(renderer.toneMappingExposure).toBe(1.4)

    postProcessing.dispose()

    expect(renderer.autoClear).toBe(true)
    expect(renderer.toneMappingExposure).toBe(1)
  })

  it('renders ambient occlusion for the high preset with physical shading', () => {
    const renderer = new WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true })
    renderers.push(renderer)
    renderer.setSize(64, 64, false)

    const config = resolveMMDGraphics('high', DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, 'hybrid')!
    const postProcessing = new MMDPostProcessing(renderer, new Scene(), new PerspectiveCamera())
    postProcessing.apply(config)
    postProcessing.render(0)

    expect(config.ambientOcclusion).toBeDefined()
    expect(renderer.getContext().getError()).toBe(renderer.getContext().NO_ERROR)
    postProcessing.dispose()
  })
})
