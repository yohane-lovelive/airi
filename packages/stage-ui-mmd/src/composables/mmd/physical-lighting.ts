import type { DirectionalLight, Object3D, Scene, Vector3, WebGLRenderer, WebGLRenderTarget } from 'three'

import type { MMDLightingConfig } from '../../utils/mmd-graphics'

import { Box3, Mesh, PCFShadowMap, PMREMGenerator, Sphere } from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

/**
 * Adds the lights that physically based MMD materials need: a studio environment light and soft self-shadows from the
 * directional light.
 *
 * State model:
 * - The environment map is made on first use and kept until `dispose`, because the room render takes some time.
 * - `apply(undefined)` removes the environment and the shadows, so toon mode renders as before.
 * - `fit` moves the directional light and its shadow camera around the model. The light direction does not change.
 *
 * Use when:
 * - The render mode is hybrid or PBR. Toon materials ignore the environment light.
 */
export class MMDPhysicalLighting {
  private environment: WebGLRenderTarget | undefined
  private readonly bounds = new Sphere()

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly light: DirectionalLight,
  ) {
    this.renderer.shadowMap.type = PCFShadowMap
    this.light.shadow.mapSize.set(2048, 2048)
    // Softer than a sun shadow, as a studio key light gives.
    this.light.shadow.radius = 4
    this.light.shadow.intensity = 0.6
    // The light aims at its target, so the target must be in the scene to follow the model.
    this.scene.add(this.light.target)
  }

  apply(config: MMDLightingConfig | undefined) {
    if (!config) {
      this.scene.environment = null
      this.setShadows(false)
      return
    }
    this.environment ??= this.createEnvironment()
    this.scene.environment = this.environment.texture
    this.scene.environmentIntensity = config.environmentIntensity
    this.setShadows(config.shadows)
  }

  /**
   * Places the light and its shadow camera around a model. Call it after a model loads or moves, and after the light
   * direction changes.
   *
   * @param model The model to fit. Without it, the light keeps the last model bounds.
   * @param direction The direction from the model to the light, as the owner set it.
   */
  fit(model: Object3D | undefined, direction: Vector3) {
    if (model) {
      model.updateMatrixWorld(true)
      new Box3().setFromObject(model).getBoundingSphere(this.bounds)
      model.traverse((object) => {
        if (object instanceof Mesh) {
          object.castShadow = true
          object.receiveShadow = true
        }
      })
    }
    const radius = Math.max(this.bounds.radius, 1e-3)
    this.light.target.position.copy(this.bounds.center)
    this.light.position.copy(direction).normalize().multiplyScalar(radius * 2).add(this.bounds.center)

    const camera = this.light.shadow.camera
    camera.left = -radius
    camera.right = radius
    camera.top = radius
    camera.bottom = -radius
    camera.near = radius * 0.5
    camera.far = radius * 3.5
    camera.updateProjectionMatrix()
    // Offsets along the normal keep the model from shadowing itself in stripes. They scale with the model size.
    this.light.shadow.normalBias = radius * 0.004
    this.light.shadow.bias = -radius * 0.00002
  }

  dispose() {
    this.apply(undefined)
    this.environment?.dispose()
    this.environment = undefined
    this.scene.remove(this.light.target)
  }

  private createEnvironment() {
    const generator = new PMREMGenerator(this.renderer)
    const room = new RoomEnvironment()
    const target = generator.fromScene(room, 0.04)
    room.dispose()
    generator.dispose()
    return target
  }

  private setShadows(enabled: boolean) {
    this.renderer.shadowMap.enabled = enabled
    this.light.castShadow = enabled
  }
}
