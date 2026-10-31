<script setup lang="ts">
/*
  * Root MMD scene component.
  *
  * Unlike the VRM renderer (which is declarative via TresJS), MMD is driven
  * imperatively: the MMD runtime coordinates mixer, IK, grant, and physics in
  * a hand-managed render loop. This component owns the WebGLRenderer, camera,
  * lights, OrbitControls, and the per-frame pipeline, and exposes the same
  * contract Stage.vue expects from every renderer.
*/

import type { SkinnedMesh, Texture } from 'three'

import type { GazeOffset, MMDAnimationManager, MorphController } from '../../composables/mmd'
import type { ResolvedMMDModel } from '../../utils/mmd-loader'

import { errorMessageFrom } from '@moeru/std'
import { coverRect } from '@proj-airi/stage-shared'
import { Screen } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import {
  AmbientLight,
  Box3,
  Clock,
  Color,
  DirectionalLight,
  Group,
  NeutralToneMapping,
  NoToneMapping,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three-stdlib'
import { onMounted, onUnmounted, ref, toRef, watch } from 'vue'

import {
  createGazeController,
  createMMDAnimationManager,
  createMorphController,
  EYE_PITCH_LIMIT,
  EYE_YAW_LIMIT,
  loadMMDAnimationClip,
  MMDPhysicalLighting,
  MMDPostProcessing,
  useMMDBlink,
  useMMDEmote,
  useMMDLipSync,
} from '../../composables/mmd'
import { DEFAULT_IDLE_MOTION } from '../../constants/actions'
import { Emotion, EMOTION_VALUES } from '../../constants/emotions'
import { useMMD } from '../../stores/mmd'
import { resolveMMDGraphics, resolveMMDLighting } from '../../utils/mmd-graphics'
import { loadMMDModelFromSource } from '../../utils/mmd-loader'
import {
  applyMMDMaterialOpacity,
  applyMMDRenderMode,
  collectMMDMaterials,
  disposeMMDObject,
  setMMDMaterialGlow,
  setMMDRimLight,
} from '../../utils/mmd-materials'
import { loadVRMAnimationFile } from '../../utils/vrma-loader'
import { mmdRigFromMesh, retargetVRMAnimationToMMD } from '../../utils/vrma-retarget'

const props = withDefaults(defineProps<{
  /** The context that owns `currentAudioSource`. */
  audioContext?: AudioContext
  modelSrc?: string
  modelId?: string
  paused?: boolean
  cursorPosition?: { x: number, y: number }
  /**
   * Scene painted behind the model, inside this canvas rather than under it, so one
   * readback answers for the whole stage.
   */
  backgroundUrl?: string | null
  currentAudioSource?: AudioBufferSourceNode
  enableOrbitControls?: boolean
  /**
   * A `.vrma` idle loop, retargeted to the MMD bones. It plays while the owner has chosen no VMD idle, so a model does
   * not stand in its rest pose.
   */
  defaultIdleAnimationUrl?: string
}>(), {
  paused: false,
  enableOrbitControls: false,
})

const emit = defineEmits<{
  (e: 'error', err: unknown): void
}>()

const componentState = defineModel<'pending' | 'loading' | 'mounted'>('state', { default: 'pending' })

const mmdStore = useMMD()
const {
  physicsEnabled,
  ikEnabled,
  grantEnabled,
  physicsGravity,
  gazeMode,
  position,
  scale,
  rotationY,
  morphOverrides,
  emotionActionMap,
  materialOpacity,
  idleMotionName,
  availableMotions,
  oneShotAction,
  cameraFov,
  ambientColor,
  ambientIntensity,
  directionalColor,
  directionalIntensity,
  directionalPosition,
  albedoGlow,
  renderScale,
  graphicsQuality,
  graphicsAdjustments,
  renderMode,
  materialSurfaces,
} = storeToRefs(mmdStore)

const canvasRef = ref<HTMLCanvasElement>()

// Imperative three.js objects (no reactivity — mutated in the render loop).
let renderer: WebGLRenderer | undefined
let scene: Scene | undefined
let camera: PerspectiveCamera | undefined
let controls: OrbitControls | undefined
/** Present while the graphics quality is not `off`. Without it, the scene renders directly. */
let postProcessing: MMDPostProcessing | undefined
let ambientLight: AmbientLight | undefined
let directionalLight: DirectionalLight | undefined
/** The environment light and shadows of hybrid and PBR modes. */
let physicalLighting: MMDPhysicalLighting | undefined
let modelGroup: Group | undefined
let resolved: ResolvedMMDModel | undefined
let mesh: SkinnedMesh | undefined
let morphs: MorphController | undefined
let animation: MMDAnimationManager | undefined
let emote: ReturnType<typeof useMMDEmote> | undefined
// Motion names already bound to the current model runtime.
const registeredMotions = new Set<string>()
/** Loaded `.vrma` files by URL, so a model change does not fetch the idle again. */
const vrmAnimations = new Map<string, ReturnType<typeof loadVRMAnimationFile>>()
const clock = new Clock()
let rafHandle = 0

// Lip-sync owns Vue lifecycle hooks, so it must be created during setup.
const lipSync = useMMDLipSync(
  toRef(props, 'audioContext'),
  toRef(props, 'currentAudioSource'),
)
const blink = useMMDBlink()
let gaze: ReturnType<typeof createGazeController> | undefined

function canvasElement() {
  return canvasRef.value
}

function captureFrame(): Promise<Blob | null> | undefined {
  if (!renderer || !scene || !camera)
    return undefined
  // preserveDrawingBuffer keeps the last frame readable for the snapshot. The snapshot goes through the same effects.
  renderFrame(0)
  return new Promise(resolve => canvasRef.value?.toBlob(resolve, 'image/png'))
}

/**
 * Resolves the gaze target for the current tracking mode.
 *
 * - `none`   → `undefined`, so the gaze controller idle-saccades.
 * - `camera` → centered offset, so the model looks forward toward the camera.
 * - `mouse`  → cursor position normalized to the canvas, or `undefined`
 *   (idle saccades) when there is no cursor.
 */
function resolveGazeOffset(): GazeOffset | undefined {
  if (gazeMode.value === 'none')
    return undefined

  if (gazeMode.value === 'camera') {
    // Aim the eyes at the camera: take the camera direction relative to the
    // look-at center, bring it into the model's local frame (so the user's
    // rotation is accounted for), and convert to yaw/pitch fractions of the
    // eye swing limits. Clamped, so an off-axis camera reads as a hard look.
    if (!camera || !controls || !modelGroup)
      return { x: 0, y: 0 }
    const dir = camera.position.clone().sub(controls.target).normalize()
    dir.applyQuaternion(new Quaternion().copy(modelGroup.quaternion).invert())
    const yaw = Math.atan2(dir.x, dir.z)
    const pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)))
    return {
      x: Math.max(-1, Math.min(1, yaw / EYE_YAW_LIMIT)),
      y: Math.max(-1, Math.min(1, -pitch / EYE_PITCH_LIMIT)),
    }
  }

  // mouse
  if (!props.cursorPosition || !canvasRef.value)
    return undefined
  const rect = canvasRef.value.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0)
    return undefined
  const nx = ((props.cursorPosition.x - rect.left) / rect.width) * 2 - 1
  const ny = ((props.cursorPosition.y - rect.top) / rect.height) * 2 - 1
  return { x: Math.max(-1, Math.min(1, nx)), y: Math.max(-1, Math.min(1, ny)) }
}

function applyTransform() {
  if (!modelGroup)
    return
  modelGroup.scale.setScalar(scale.value)
  modelGroup.rotation.y = rotationY.value
  modelGroup.position.set(position.value.x, position.value.y, 0)
  placeDirectionalLight()
}

/** Aims the directional light from the owner's direction at the model, so its shadows cover the model. */
function placeDirectionalLight() {
  const { x, y, z } = directionalPosition.value
  physicalLighting?.fit(modelGroup, new Vector3(x, y, z))
}

/**
 * three.Color rejects 8-digit `#RRGGBBAA` hex, which the color picker emits.
 * Strip the alpha channel so light colors actually apply.
 */
function normalizeHex(hex: string): string {
  return /^#[0-9a-f]{8}$/i.test(hex) ? hex.slice(0, 7) : hex
}

function setupScene() {
  const canvas = canvasRef.value!
  renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true })
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = directToneMapping()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * renderScale.value)

  scene = new Scene()
  // The scene is already chosen when the renderer mounts, so the watcher below never
  // fires for it.
  void syncBackground()
  camera = new PerspectiveCamera(cameraFov.value, 1, 0.1, 1000)
  camera.position.set(0, 1, 3)

  // Toon shading with an albedo self-glow (applied at load): keep direct lights
  // moderate so the lit side doesn't blow out, while the glow + ambient keep the
  // shadow side bright. All values are user-adjustable via the settings store.
  ambientLight = new AmbientLight(new Color(normalizeHex(ambientColor.value)), ambientIntensity.value)
  scene.add(ambientLight)
  directionalLight = new DirectionalLight(new Color(normalizeHex(directionalColor.value)), directionalIntensity.value)
  scene.add(directionalLight)
  physicalLighting = new MMDPhysicalLighting(renderer, scene, directionalLight)
  placeDirectionalLight()

  controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.enabled = props.enableOrbitControls
}

/** Frames the camera so the whole model fits the viewport, and centers it. */
function frameCamera() {
  if (!camera || !controls || !modelGroup)
    return
  modelGroup.updateMatrixWorld(true)
  const box = new Box3().setFromObject(modelGroup)
  if (box.isEmpty())
    return
  const size = box.getSize(new Vector3())
  const center = box.getCenter(new Vector3())

  // Fit to BOTH axes using the camera aspect, so the model fills a portrait or
  // landscape viewport without being cropped (mirrors Spine's auto-fit).
  const vFov = (camera.fov * Math.PI) / 180
  const fitHeightDistance = (size.y / 2) / Math.tan(vFov / 2)
  const fitWidthDistance = (size.x / 2) / (Math.tan(vFov / 2) * camera.aspect)
  const distance = 1.2 * Math.max(fitHeightDistance, fitWidthDistance)

  camera.position.set(center.x, center.y, center.z + distance)
  camera.near = Math.max(distance / 100, 0.01)
  camera.far = distance * 100
  camera.updateProjectionMatrix()
  camera.lookAt(center)
  controls.target.copy(center)
  controls.update()
}

let backgroundTexture: Texture | undefined

/**
 * Fits the scene over the canvas, matching the `cover` framing it had as a CSS layer.
 *
 * A background texture covers the viewport whatever its own shape, so the fit is
 * expressed by sampling a smaller window of it rather than by placing a rectangle.
 *
 * Nothing is marked dirty: a background rebuilds its own texture matrix each frame,
 * while marking the texture would re-upload it and recompile the background shader.
 */
function layoutBackground() {
  if (!backgroundTexture || !renderer)
    return

  // `Texture.image` is whatever the loader produced; a decoded image carries its size.
  const image = backgroundTexture.image as { width?: number, height?: number } | undefined
  if (!image?.width || !image?.height)
    return

  const size = renderer.getSize(new Vector2())
  if (!size.x || !size.y)
    return

  const rect = coverRect({ width: size.x, height: size.y }, { width: image.width, height: image.height })
  backgroundTexture.repeat.set(size.x / rect.width, size.y / rect.height)
  backgroundTexture.offset.set(-rect.x / rect.width, -rect.y / rect.height)
}

async function syncBackground() {
  if (!scene)
    return

  const url = props.backgroundUrl
  if (!url) {
    scene.background = null
    backgroundTexture?.dispose()
    backgroundTexture = undefined
    return
  }

  const owner = scene
  // A scene that cannot decode leaves the stage as it is, rather than throwing where
  // nothing is waiting to catch it.
  let texture: Texture
  try {
    texture = await new TextureLoader().loadAsync(url)
  }
  catch {
    return
  }

  // Scene art is authored in sRGB. Saying so keeps the renderer from encoding it a
  // second time, and marks the background as already display-referred so tone mapping
  // leaves it alone.
  texture.colorSpace = SRGBColorSpace
  // This renderer keeps three's premultiplied drawing buffer, and a background is
  // written to it unblended, so the scene has to arrive premultiplied as well. Scene art
  // is roughly half soft alpha, which is where the difference would show.
  texture.premultiplyAlpha = true

  // A later scene wins, and so does a later stage: both can be replaced while the
  // texture loads.
  if (props.backgroundUrl !== url || scene !== owner) {
    texture.dispose()
    return
  }

  backgroundTexture?.dispose()
  backgroundTexture = texture
  scene.background = texture
  layoutBackground()
}

watch(() => props.backgroundUrl, () => void syncBackground())

function resize() {
  if (!renderer || !camera || !canvasRef.value)
    return
  const w = canvasRef.value.clientWidth
  const h = canvasRef.value.clientHeight
  if (w === 0 || h === 0)
    return
  renderer.setSize(w, h, false)
  postProcessing?.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  layoutBackground()
}

function renderLoop() {
  rafHandle = requestAnimationFrame(renderLoop)
  const delta = clock.getDelta()

  if (props.paused || !renderer || !scene || !camera)
    return

  if (animation) {
    // three-mmd preserves the required mixer → IK → grant → physics order.
    animation.update(delta)
    // Apply AIRI-owned morphs after the runtime so lip-sync/expression win
    // over any VMD mouth/expression keyframes.
    emote?.update(delta)
    blink.update(morphs, delta)
    lipSync.update(morphs, delta)
    // Gaze rotates eye/head bones, also after the helper.
    gaze?.update(resolveGazeOffset(), delta)
  }

  controls?.update()
  renderFrame(delta)
}

function renderFrame(delta: number) {
  if (!renderer || !scene || !camera)
    return
  if (postProcessing)
    postProcessing.render(delta)
  else
    renderer.render(scene, camera)
}

/**
 * The tone mapping when the scene renders without post-processing. Toon materials are not HDR, and a filmic curve
 * washes them out, so they render directly. Physically based materials can pass 1.0, so they need a curve. The neutral
 * curve leaves colors below about 0.8 as they are, so faces that stay toon do not change.
 */
function directToneMapping() {
  return renderMode.value === 'toon' ? NoToneMapping : NeutralToneMapping
}

/** Turns the environment light, the shadows, and the rim light on or off for the render mode. */
function applyLighting() {
  physicalLighting?.apply(resolveMMDLighting(renderMode.value, graphicsAdjustments.value))
  if (modelGroup)
    setMMDRimLight(modelGroup, graphicsAdjustments.value.rimIntensity)
}

/** Builds, rebuilds, or removes the post-processing for the current graphics settings. */
function applyGraphics() {
  if (!renderer || !scene || !camera)
    return
  const config = resolveMMDGraphics(graphicsQuality.value, graphicsAdjustments.value, renderMode.value)
  // The post-processing has its own tone mapping pass.
  renderer.toneMapping = config ? NoToneMapping : directToneMapping()
  if (!config) {
    postProcessing?.dispose()
    postProcessing = undefined
    return
  }
  postProcessing ??= new MMDPostProcessing(renderer, scene, camera)
  postProcessing.apply(config)
  resize()
}

function disposeModel() {
  const runtimeDisposedByManager = animation !== undefined
  if (animation) {
    animation.dispose()
    animation = undefined
  }
  if (!runtimeDisposedByManager)
    resolved?.mmd.dispose()

  if (modelGroup && scene) {
    scene.remove(modelGroup)
    disposeMMDObject(modelGroup)
  }
  resolved?.dispose()
  registeredMotions.clear()
  modelGroup = undefined
  mesh = undefined
  morphs = undefined
  emote = undefined
  gaze = undefined
  resolved = undefined
  mmdStore.isModelLoaded = false
}

/**
 * Loads and registers any imported VMD motions not yet bound to the current
 * model, then (re)applies the selected idle motion. Safe to call repeatedly;
 * already-registered motions are skipped.
 */
async function syncMotions() {
  if (!animation || !mesh)
    return

  for (const descriptor of availableMotions.value) {
    if (registeredMotions.has(descriptor.name))
      continue
    try {
      // The VMD file lives in IndexedDB (shared across windows); build a
      // window-local object URL to load it, then revoke it once parsed.
      const file = await mmdStore.getMotionFile(descriptor.id)
      if (!file) {
        console.warn(`[mmd] motion file "${descriptor.name}" (${descriptor.id}) not found in storage`)
        continue
      }
      const url = URL.createObjectURL(file)
      try {
        const clip = await loadMMDAnimationClip(url, mesh)
        animation.registerClip(descriptor.name, clip)
        registeredMotions.add(descriptor.name)
        if (clip.tracks.length === 0) {
          console.warn(
            `[mmd] motion "${descriptor.name}" loaded but has 0 tracks matching this model. `
            + 'The VMD\'s bone/morph names likely do not match the model (different rig/naming).',
          )
        }
      }
      finally {
        URL.revokeObjectURL(url)
      }
    }
    catch (err) {
      console.error('[mmd] failed to load motion', descriptor.name, errorMessageFrom(err))
      emit('error', err)
    }
  }

  applyIdleMotion()
}

/** Plays the chosen VMD idle, or the default idle while none is chosen or the chosen one is not loaded. */
function applyIdleMotion() {
  if (!animation)
    return
  if (idleMotionName.value && registeredMotions.has(idleMotionName.value))
    animation.setIdleMotion(idleMotionName.value)
  else if (registeredMotions.has(DEFAULT_IDLE_MOTION))
    animation.setIdleMotion(DEFAULT_IDLE_MOTION)
}

/**
 * Retargets the default `.vrma` idle to the current model and registers it. `rig` must come from the model at rest.
 * A model that changed during the load keeps its own state, because the result belongs to the earlier model.
 */
async function registerDefaultIdle(rig: ReturnType<typeof mmdRigFromMesh>) {
  const url = props.defaultIdleAnimationUrl
  if (!url)
    return
  const owner = resolved
  try {
    let pending = vrmAnimations.get(url)
    if (!pending) {
      pending = loadVRMAnimationFile(url)
      vrmAnimations.set(url, pending)
    }
    const vrmAnimation = await pending
    if (!vrmAnimation || owner !== resolved || !animation)
      return
    animation.registerClip(DEFAULT_IDLE_MOTION, retargetVRMAnimationToMMD(vrmAnimation, rig, { name: DEFAULT_IDLE_MOTION }))
    registeredMotions.add(DEFAULT_IDLE_MOTION)
    applyIdleMotion()
  }
  catch (err) {
    vrmAnimations.delete(url)
    console.error('[mmd] failed to load the default idle motion:', errorMessageFrom(err))
  }
}

/**
 * Counts model loads. The mount and the source watcher can both start a load, and a load that finishes after a newer one
 * started drops its result. Without it, both models entered the scene.
 */
let loadGeneration = 0

async function loadModel(src: string) {
  if (!scene)
    return

  const generation = ++loadGeneration
  componentState.value = 'loading'
  disposeModel()

  try {
    const loaded = await loadMMDModelFromSource(src, { cacheKey: props.modelId })
    if (generation !== loadGeneration) {
      loaded.mmd.dispose()
      disposeMMDObject(loaded.mesh)
      loaded.dispose()
      return
    }
    resolved = loaded
    mesh = resolved.mesh
    // Read the rig now, while every bone is at rest. Motions move the bones later.
    const ikEffectors = new Map<number, number>()
    resolved.mmd.pmx.bones.forEach((bone, index) => {
      if (bone.ik)
        ikEffectors.set(index, bone.ik.target)
    })
    const rig = mmdRigFromMesh(mesh, ikEffectors)

    modelGroup = new Group()
    modelGroup.add(mesh)
    applyTransform()
    scene.add(modelGroup)

    morphs = createMorphController(mesh, morphOverrides.value)
    mmdStore.availableMorphs = morphs.availableMorphs
    if (!morphs.resolvedSlots.some(slot => slot.startsWith('vowel'))) {
      console.warn(
        '[mmd] no vowel mouth morphs (あ/い/う/え/お) resolved; lip-sync cannot move the mouth. '
        + 'Available morphs:',
        morphs.availableMorphs,
      )
    }

    emote = useMMDEmote(morphs)
    gaze = createGazeController(mesh)

    animation = createMMDAnimationManager(resolved.mmd, { physicsEnabled: physicsEnabled.value })
    await animation.init()
    // A newer load already disposed this model when it started.
    if (generation !== loadGeneration)
      return
    // No idle VMD ships, so the VRM idle loop plays until the owner chooses one.
    void registerDefaultIdle(rig)
    animation.setIKEnabled(ikEnabled.value)
    animation.setGrantEnabled(grantEnabled.value)
    animation.setGravity(physicsGravity.value)

    // Ensure the camera aspect matches the live canvas before fitting.
    resize()
    frameCamera()
    applyRenderMode()
    applyLighting()
    setMMDMaterialGlow(modelGroup, albedoGlow.value)
    mmdStore.availableMaterials = collectMMDMaterials(modelGroup)
    applyMMDMaterialOpacity(modelGroup, materialOpacity.value)

    mmdStore.isModelLoaded = true
    componentState.value = 'mounted'

    // Bind any motions imported before this model mounted.
    await syncMotions()
  }
  catch (err) {
    // A failed load that a newer load replaced must not dispose the newer model.
    if (generation !== loadGeneration)
      return
    disposeModel()
    componentState.value = 'pending'
    console.error('[mmd] failed to load model:', errorMessageFrom(err))
    emit('error', err)
  }
}

/** Swaps the model's materials for the render mode and the owner's material changes. */
function applyRenderMode() {
  if (!modelGroup)
    return
  applyMMDRenderMode(modelGroup, renderMode.value, materialSurfaces.value[props.modelId ?? ''])
  // A new physical material starts at the authored opacity.
  applyMMDMaterialOpacity(modelGroup, materialOpacity.value)
}

/** Plays the gesture motion mapped to an emotion, if the model has one. */
function setEmotion(emotion: string, intensity = 1) {
  const value = EMOTION_VALUES.includes(emotion as Emotion) ? emotion as Emotion : Emotion.Neutral
  emote?.setEmotion(value, intensity)

  const actionName = emotionActionMap.value[value]
  if (actionName)
    animation?.playAction(actionName, { loop: false })
}

let resizeObserver: ResizeObserver | undefined

onMounted(() => {
  setupScene()
  applyLighting()
  applyGraphics()
  resizeObserver = new ResizeObserver(() => resize())
  if (canvasRef.value)
    resizeObserver.observe(canvasRef.value)
  resize()
  clock.start()
  renderLoop()

  if (props.modelSrc)
    loadModel(props.modelSrc)
})

onUnmounted(() => {
  cancelAnimationFrame(rafHandle)
  resizeObserver?.disconnect()
  loadGeneration++
  disposeModel()
  postProcessing?.dispose()
  postProcessing = undefined
  physicalLighting?.dispose()
  physicalLighting = undefined
  controls?.dispose()
  backgroundTexture?.dispose()
  backgroundTexture = undefined
  if (renderer) {
    renderer.dispose()
    renderer.forceContextLoss()
  }
  scene = undefined
  camera = undefined
  renderer = undefined
  controls = undefined
  ambientLight = undefined
  directionalLight = undefined
})

watch(() => props.modelSrc, (src) => {
  if (src) {
    loadModel(src)
    return
  }
  loadGeneration++
  disposeModel()
})

watch(() => props.enableOrbitControls, (enabled) => {
  if (controls)
    controls.enabled = enabled
})

// View transform sliders.
watch([scale, rotationY, () => position.value.x, () => position.value.y], () => applyTransform())

// Solver/physics toggles.
watch(physicsEnabled, v => animation?.setPhysicsEnabled(v))
watch(ikEnabled, v => animation?.setIKEnabled(v))
watch(grantEnabled, v => animation?.setGrantEnabled(v))
watch(physicsGravity, v => animation?.setGravity(v))

// Morph-slot overrides: rebind each slot the user remapped (empty = auto).
watch(morphOverrides, (overrides) => {
  if (!morphs)
    return
  for (const [slot, name] of Object.entries(overrides))
    morphs.override(slot as Parameters<MorphController['override']>[0], name ?? '')
}, { deep: true })

// One-shot motion requests from tools/the act bus.
watch(oneShotAction, (request) => {
  if (request)
    animation?.playAction(request.name, { loop: request.loop })
})

// Newly imported VMD motions: load and register them against the live model.
watch(availableMotions, () => {
  void syncMotions()
}, { deep: true })

// Idle-motion selection from the settings panel.
watch(idleMotionName, applyIdleMotion)

// Scene settings — lighting.
watch([ambientColor, ambientIntensity], () => {
  if (!ambientLight)
    return
  ambientLight.color.set(normalizeHex(ambientColor.value))
  ambientLight.intensity = ambientIntensity.value
})
watch([directionalColor, directionalIntensity], () => {
  if (!directionalLight)
    return
  directionalLight.color.set(normalizeHex(directionalColor.value))
  directionalLight.intensity = directionalIntensity.value
})
watch(directionalPosition, placeDirectionalLight, { deep: true })

// Scene settings — camera & rendering.
watch(cameraFov, () => {
  if (!camera)
    return
  camera.fov = cameraFov.value
  camera.updateProjectionMatrix()
})
watch(renderScale, () => {
  renderer?.setPixelRatio(Math.min(window.devicePixelRatio, 2) * renderScale.value)
  resize()
})
watch([graphicsQuality, graphicsAdjustments], () => {
  applyLighting()
  applyGraphics()
}, { deep: true })
watch(renderMode, () => {
  applyRenderMode()
  applyLighting()
  applyGraphics()
})
watch(() => materialSurfaces.value[props.modelId ?? ''], () => {
  applyRenderMode()
  // New physical materials start without the rim light.
  applyLighting()
}, { deep: true })
watch(albedoGlow, () => {
  if (modelGroup)
    setMMDMaterialGlow(modelGroup, albedoGlow.value)
})
watch(materialOpacity, () => {
  if (modelGroup)
    applyMMDMaterialOpacity(modelGroup, materialOpacity.value)
}, { deep: true })

defineExpose({
  canvasElement,
  captureFrame,
  setEmotion,
  listMorphs: () => morphs?.availableMorphs ?? [],
  listMotions: () => animation?.availableClips() ?? [],
})
</script>

<template>
  <Screen relative>
    <canvas ref="canvasRef" h-full w-full />
  </Screen>
</template>
