import type { MMDToonMaterial } from '@moeru/three-mmd/materials/toon'
import type { BufferGeometry, Material, Object3D } from 'three'

import type { MMDRenderMode, MMDSurface, MMDSurfaceKind, MMDSurfaceOverride } from './mmd-pbr'

import { MMDPhysicalMaterial } from '@moeru/three-mmd/materials/physical'
import { Mesh, SkinnedMesh } from 'three'

import { classifyMMDMaterial, resolveMMDSurface, usesPhysicalMaterial } from './mmd-pbr'

interface OriginalSurfaceState {
  opacity: number
  transparent: boolean
}

/** A loader-owned or a physical MMD surface. Both carry the MMD descriptor, the glow, and the opacity state. */
type MMDSurfaceMaterial = MMDToonMaterial | MMDPhysicalMaterial

const originalSurfaceStates = new WeakMap<MMDSurfaceMaterial, OriginalSurfaceState>()

/**
 * The surfaces of one mesh across render modes. `toon` holds the loaded materials by slot. `physical` holds a
 * physically based twin per slot, made on first use and kept, so that a mode change does not recompile shaders.
 */
interface RenderModeRecord {
  toon: MMDToonMaterial[]
  physical: Map<number, MMDPhysicalMaterial>
  /** By slot, the share of vertices that mainly follow the head bone. It finds face materials without a name. */
  headShares: number[]
}

const renderModeRecords = new WeakMap<Mesh, RenderModeRecord>()

/** The rim light strength of each physical material, as a shader uniform. */
const rimLightUniforms = new WeakMap<MMDPhysicalMaterial, { value: number }>()

/**
 * Lights the surface edges that face away from the camera, tinted by the surface color. It separates the model from
 * the background, as the rim lights of MMD effect packs do.
 */
const RIM_LIGHT_FRAGMENT = `
#include <emissivemap_fragment>
float mmdRim = pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 3.0 );
totalEmissiveRadiance += mix( vec3( 1.0 ), diffuseColor.rgb, 0.5 ) * mmdRim * mmdRimIntensity;
`

/** The MMD surfaces of a mesh, without generated outline materials. */
function mmdMaterialsOf(mesh: Mesh): MMDSurfaceMaterial[] {
  const materials: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  return materials.filter((material): material is MMDSurfaceMaterial => 'isMMDMaterial' in material && material.isMMDMaterial === true)
}

function forEachMMDMaterial(root: Object3D, visit: (material: MMDSurfaceMaterial) => void): void {
  root.traverse((object) => {
    if (object instanceof Mesh)
      mmdMaterialsOf(object).forEach(material => visit(material))
  })
}

/**
 * Applies AIRI's albedo-glow policy to loader-owned MMD surfaces.
 *
 * Generated outline and shadow-pass materials remain under three-mmd's
 * control, while all render meshes opt out of bind-pose frustum culling.
 */
export function prepareMMDMaterials(root: Object3D, glow = 0.45): void {
  root.traverse((object) => {
    if (object instanceof Mesh)
      object.frustumCulled = false
  })

  forEachMMDMaterial(root, (material) => {
    if (material.map) {
      material.emissiveMap = material.map
      material.emissive.setScalar(1)
    }
    else {
      material.emissiveMap = null
      material.emissive.copy(material.color)
    }

    material.emissiveIntensity = glow
    material.needsUpdate = true
  })
}

/**
 * Updates AIRI's live albedo-glow setting without modifying outline passes. Physical materials have a black emissive
 * color, so the glow does not change them.
 */
export function setMMDMaterialGlow(root: Object3D, glow: number): void {
  forEachMMDMaterial(root, (material) => {
    material.emissiveIntensity = glow
  })
}

/**
 * Returns user-configurable surface materials in loader traversal order. The `index` keys the owner's surface changes
 * of {@link applyMMDRenderMode}.
 */
export function collectMMDMaterials(root: Object3D): { name: string, label: string, index: number, kind: MMDSurfaceKind }[] {
  const descriptors: { name: string, label: string, index: number, kind: MMDSurfaceKind }[] = []
  root.traverse((object) => {
    if (!(object instanceof Mesh))
      return
    const record = renderModeRecordOf(object)
    const materials = record?.toon ?? mmdMaterialsOf(object)
    materials.forEach((material, slot) => {
      const index = descriptors.length
      descriptors.push({
        name: material.name,
        label: material.name || `Material ${index}`,
        index,
        kind: classifyMMDMaterial({
          name: material.name,
          textureFileName: record?.toon[slot].descriptor.mapFileName,
          headShare: record?.headShares[slot],
        }),
      })
    })
  })
  return descriptors
}

/**
 * Applies named opacity overrides to MMD surfaces.
 *
 * Removing an override restores the authored opacity and transparency instead
 * of forcing an opaque default. Outline alpha remains owned by three-mmd.
 */
export function applyMMDMaterialOpacity(root: Object3D, overrides: Record<string, number>): void {
  forEachMMDMaterial(root, (material) => {
    let original = originalSurfaceStates.get(material)
    if (!original) {
      original = {
        opacity: material.opacity,
        transparent: material.transparent,
      }
      originalSurfaceStates.set(material, original)
    }

    const override = overrides[material.name]
    material.opacity = override ?? original.opacity
    material.transparent = override === undefined
      ? original.transparent
      : original.transparent || override < 1
    material.needsUpdate = true
  })
}

/**
 * Shades each MMD surface with its toon material or with a physically based twin, as the mode and the material kind
 * decide. The twin replaces the toon material in its slot, so three-mmd's SDEF shadow pass still finds it.
 *
 * Call {@link applyMMDMaterialOpacity} after this, because a new twin starts at the authored opacity.
 *
 * @param root The model.
 * @param mode The render mode.
 * @param overrides The owner's changes by the material `index` of {@link collectMMDMaterials}. Names do not work as
 * keys, because one name can cover the face skin and the clothes, for example `huku3w.bmp` in Lat-style Miku.
 */
export function applyMMDRenderMode(
  root: Object3D,
  mode: MMDRenderMode,
  overrides: Record<string, MMDSurfaceOverride> = {},
): void {
  let catalogIndex = 0
  root.traverse((object) => {
    if (!(object instanceof Mesh))
      return
    const record = renderModeRecordOf(object)
    if (!record) {
      // Keep the count in step with the catalog, which also lists these materials.
      catalogIndex += mmdMaterialsOf(object).length
      return
    }

    const slots = record.toon.map((toon, index) => {
      const surface = resolveMMDSurface(
        { name: toon.name, textureFileName: toon.descriptor.mapFileName, headShare: record.headShares[index] },
        overrides[catalogIndex++],
      )
      if (!usesPhysicalMaterial(mode, surface.kind))
        return toon

      let physical = record.physical.get(index)
      if (!physical) {
        physical = createPhysicalTwin(toon)
        record.physical.set(index, physical)
      }
      applyPhysicalSurface(physical, surface)
      return physical
    })

    if (Array.isArray(object.material))
      slots.forEach((material, index) => object.material[index] = material)
    else
      object.material = slots[0]
  })
}

function renderModeRecordOf(mesh: Mesh): RenderModeRecord | undefined {
  const existing = renderModeRecords.get(mesh)
  if (existing)
    return existing

  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  if (materials.length === 0 || !materials.every(isMMDToonMaterial))
    return undefined

  // Hybrid mode tone maps the physical materials. A toon face lit above 1.0 must still clip to its flat color, so toon
  // materials keep their colors as authored.
  for (const toon of materials)
    toon.toneMapped = false
  const record: RenderModeRecord = { toon: [...materials], physical: new Map(), headShares: headSharesOf(mesh) }
  renderModeRecords.set(mesh, record)
  return record
}

/** For each material slot, the share of its vertices whose strongest bone weight is on the head bone `頭`. */
function headSharesOf(mesh: Mesh): number[] {
  const { geometry } = mesh
  const head = mesh instanceof SkinnedMesh ? mesh.skeleton.bones.findIndex(bone => bone.name === '頭') : -1
  const skinIndex = geometry.getAttribute('skinIndex')
  const skinWeight = geometry.getAttribute('skinWeight')
  if (head < 0 || !skinIndex || !skinWeight)
    return []

  const shares: number[] = []
  for (const group of geometry.groups) {
    let onHead = 0
    for (let i = group.start; i < group.start + group.count; i++) {
      const vertex = geometry.index ? geometry.index.getX(i) : i
      let strongest = 0
      let bone = -1
      for (let influence = 0; influence < 4; influence++) {
        const weight = skinWeight.getComponent(vertex, influence)
        if (weight > strongest) {
          strongest = weight
          bone = skinIndex.getComponent(vertex, influence)
        }
      }
      if (bone === head)
        onHead++
    }
    shares[group.materialIndex ?? 0] = group.count > 0 ? onHead / group.count : 0
  }
  return shares
}

function isMMDToonMaterial(material: Material): material is MMDToonMaterial {
  return 'isMMDToonMaterial' in material && material.isMMDToonMaterial === true
}

/** Makes a physical material that keeps the toon material's alpha, sides, blending, glow, and SDEF state. */
function createPhysicalTwin(toon: MMDToonMaterial): MMDPhysicalMaterial {
  const physical = new MMDPhysicalMaterial(toon.descriptor)
  physical.setSdefEnabled(toon.defines?.MMD_USE_SDEF !== 0)

  // three-mmd keeps the texture alpha check and the alpha morph flag private, so copy their result.
  const original = originalSurfaceStates.get(toon)
  physical.opacity = original?.opacity ?? toon.opacity
  physical.transparent = original?.transparent ?? toon.transparent
  physical.alphaTest = toon.alphaTest
  physical.depthWrite = toon.depthWrite
  physical.side = toon.side
  // The toon blending keeps the destination alpha, which the transparent desktop window needs.
  physical.blending = toon.blending
  physical.blendSrc = toon.blendSrc
  physical.blendDst = toon.blendDst
  physical.blendSrcAlpha = toon.blendSrcAlpha
  physical.blendDstAlpha = toon.blendDstAlpha
  // No albedo glow: it fakes the flat toon brightness, and the environment light already lights a physical surface.
  installRimLight(physical)
  return physical
}

function installRimLight(physical: MMDPhysicalMaterial): void {
  const intensity = { value: 0 }
  rimLightUniforms.set(physical, intensity)
  // three-mmd patches the SDEF skinning in its own `onBeforeCompile`, so keep it.
  const previous = physical.onBeforeCompile
  physical.onBeforeCompile = (shader, renderer) => {
    previous.call(physical, shader, renderer)
    shader.uniforms.mmdRimIntensity = intensity
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float mmdRimIntensity;')
      .replace('#include <emissivemap_fragment>', RIM_LIGHT_FRAGMENT)
  }
}

/** Sets the rim light strength, 0 to 1, of the physically based materials. Toon materials have no rim light. */
export function setMMDRimLight(root: Object3D, intensity: number): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh))
      return
    for (const physical of renderModeRecords.get(object)?.physical.values() ?? [])
      rimLightUniforms.get(physical)!.value = intensity
  })
}

function applyPhysicalSurface(physical: MMDPhysicalMaterial, surface: MMDSurface): void {
  physical.roughness = surface.roughness
  physical.metalness = surface.metalness
  physical.sheen = surface.sheen
  physical.sheenRoughness = 0.5
  physical.sheenColor.setScalar(1)
  physical.clearcoat = surface.clearcoat
  physical.clearcoatRoughness = 0.1
}

/**
 * Releases GPU resources owned by an MMD object tree exactly once.
 *
 * three-mmd outline meshes can share geometry with their surface, while SDEF
 * depth and distance materials live outside `Mesh.material`; both cases are
 * accounted for explicitly.
 */
export function disposeMMDObject(root: Object3D): void {
  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()

  root.traverse((object) => {
    if (!(object instanceof Mesh))
      return

    geometries.add(object.geometry)
    const renderMaterials = Array.isArray(object.material) ? object.material : [object.material]
    for (const material of renderMaterials)
      materials.add(material)
    // The materials of the other render mode are out of their slots, but still hold GPU programs.
    const record = renderModeRecords.get(object)
    for (const material of [...record?.toon ?? [], ...record?.physical.values() ?? []])
      materials.add(material)

    if (object.customDepthMaterial)
      materials.add(object.customDepthMaterial)
    if (object.customDistanceMaterial)
      materials.add(object.customDistanceMaterial)
  })

  for (const geometry of geometries)
    geometry.dispose()
  for (const material of materials)
    material.dispose()
}
