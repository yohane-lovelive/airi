import { Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Scene, Vector3, WebGLRenderer } from 'three'
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

  // ROOT CAUSE:
  //
  // The library bloom blurred the alpha with the colors, and its blend kept the larger alpha. A transparent window
  // then showed a dark haze around the model.
  //
  // We fixed this with a bloom that adds light only.
  it('keeps the transparent area around a bright model transparent', () => {
    const renderer = new WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true })
    renderers.push(renderer)
    renderer.setSize(64, 64, false)
    renderer.setClearColor(0x000000, 0)
    const scene = new Scene()
    const model = new Mesh(new PlaneGeometry(0.5, 0.5), new MeshBasicMaterial({ color: 0xFFFFFF }))
    model.position.z = -2
    scene.add(model)

    const postProcessing = new MMDPostProcessing(renderer, scene, new PerspectiveCamera())
    postProcessing.apply(resolveMMDGraphics('high', DEFAULT_MMD_GRAPHICS_ADJUSTMENTS)!)
    postProcessing.render(0)

    const gl = renderer.getContext()
    // The model covers about the middle 17 pixels. The first pixel reads beside it, where the blur is strongest.
    const beside = new Uint8Array(4)
    gl.readPixels(18, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, beside)
    const center = new Uint8Array(4)
    gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, center)
    expect(beside[3]).toBe(0)
    expect(center[3]).toBe(255)
    postProcessing.dispose()
  })

  it('renders ambient occlusion for the high preset with physical shading', () => {
    const renderer = new WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true })
    renderers.push(renderer)
    renderer.setSize(64, 64, false)

    const config = resolveMMDGraphics('high', DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, { renderMode: 'hybrid' })!
    const postProcessing = new MMDPostProcessing(renderer, new Scene(), new PerspectiveCamera())
    postProcessing.apply(config)
    postProcessing.render(0)

    expect(config.ambientOcclusion).toBeDefined()
    expect(renderer.getContext().getError()).toBe(renderer.getContext().NO_ERROR)
    postProcessing.dispose()
  })

  it('renders depth of field and chromatic aberration, and keeps the focus across a rebuild', () => {
    const renderer = new WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true })
    renderers.push(renderer)
    renderer.setSize(64, 64, false)

    const config = resolveMMDGraphics('medium', DEFAULT_MMD_GRAPHICS_ADJUSTMENTS, { hasBackground: true })!
    const postProcessing = new MMDPostProcessing(renderer, new Scene(), new PerspectiveCamera())
    postProcessing.setFocus(new Vector3(0, 1.5, 0), 0.8)
    postProcessing.apply(config)
    postProcessing.render(0)
    postProcessing.apply(config)
    postProcessing.render(0)

    expect(config.depthOfField).toBeDefined()
    expect(config.chromaticAberration).toBeDefined()
    expect(renderer.getContext().getError()).toBe(renderer.getContext().NO_ERROR)
    postProcessing.dispose()
  })
})
