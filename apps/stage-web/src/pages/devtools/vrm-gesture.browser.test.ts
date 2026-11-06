import type { GestureClipSource } from '@proj-airi/stage-shared/body-motion'
import type { Object3D } from 'three'

import { BUILT_IN_GESTURES } from '@proj-airi/stage-shared/body-motion'
import { ThreeScene, useModelStore } from '@proj-airi/stage-ui-three'
import { useDisplayModelsStore } from '@proj-airi/stage-ui/stores/display-models'
import { createPinia } from 'pinia'
import { MathUtils, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, shallowRef } from 'vue'

import 'virtual:uno.css'

/** The bend at the elbow in degrees, from the bones that skin the mesh. A straight arm has 0 degrees. */
function elbowBend(scene: Object3D, side: 'L' | 'R') {
  scene.updateMatrixWorld(true)
  const position = (bone: string) => scene.getObjectByName(`J_Bip_${side}_${bone}`)!.getWorldPosition(new Vector3())
  const upperArm = position('LowerArm').sub(position('UpperArm'))
  const forearm = position('Hand').sub(position('LowerArm'))
  return MathUtils.radToDeg(upperArm.angleTo(forearm))
}

describe('built-in gestures on a VRM model', () => {
  // Report: the live check of step U3 in `docs/ai/adr/2026-11-06-unity-stage-sidecar.md`, section "Coordinate frame".
  it('bends the forearms at the full angle of the keys, and gives the arms back to the idle', async () => {
    // ROOT CAUSE:
    //
    // `VRMModel.vue` held its mixer in a deep `ref`. A read returned a proxy, so `playGesture` made a second layer
    // without the idle. The idle arms kept their weight, so `cross-arms` bent the elbows 58 degrees, not 110.
    //
    // We fixed this with a `shallowRef`.
    const pinia = createPinia()
    const modelStore = useModelStore(pinia)
    modelStore.resetModelStore()
    const preset = await useDisplayModelsStore(pinia).getDisplayModel('preset-vrm-1')
    if (preset?.type !== 'url')
      throw new Error('The VRM test preset is unavailable.')

    const sceneComponent = shallowRef<InstanceType<typeof ThreeScene>>()
    const container = document.createElement('div')
    container.style.height = '600px'
    container.style.width = '800px'
    document.body.appendChild(container)

    const TestHarness = defineComponent(() => () => h(ThreeScene, {
      ref: sceneComponent,
      modelId: 'display-model-gesture',
      modelSrc: preset.url,
      style: { height: '600px', width: '800px' },
    }))

    // NOTICE:
    // Keep the app mounted until Vitest closes the browser page.
    // Vue DevTools schedules inspector work after app.unmount(), which rejects after teardown.
    // Source/context: the Stage Web Vite configuration used by this browser test.
    // Removal condition: Vue DevTools supports component-test app teardown.
    const app = createApp(TestHarness)
    app.use(pinia)
    app.mount(container)

    await expect.poll(() => modelStore.scenePhase, { timeout: 60_000 }).toBe('mounted')
    const scene = sceneComponent.value!.scene()!

    const gesture = BUILT_IN_GESTURES.find(candidate => candidate.id === 'cross-arms')!
    const source: GestureClipSource = { kind: 'keys', id: gesture.id, part: 'upper', gesture }
    expect(elbowBend(scene, 'L')).toBeLessThan(20)
    expect(elbowBend(scene, 'R')).toBeLessThan(20)

    await expect(sceneComponent.value!.playGesture(source)).resolves.toBe(true)

    // The keys hold the elbows at 110 degrees from 0.5 to 2.3 seconds of the gesture, and only those keys pass 100.
    // A headless browser renders slowly, so the long timeouts allow for slow frames and do not weaken the check.
    const smallerBend = () => Math.min(elbowBend(scene, 'L'), elbowBend(scene, 'R'))
    const largerBend = () => Math.max(elbowBend(scene, 'L'), elbowBend(scene, 'R'))
    await expect.poll(smallerBend, { interval: 50, timeout: 20_000 }).toBeGreaterThan(100)
    await expect.poll(largerBend, { timeout: 20_000 }).toBeLessThan(20)
  }, 120_000) // A real VRM load needs a generous timeout.
})
