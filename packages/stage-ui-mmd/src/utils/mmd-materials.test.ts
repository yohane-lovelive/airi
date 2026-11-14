import type { MMDMaterialDescriptor } from '@moeru/three-mmd/materials'

import { MMDPhysicalMaterial } from '@moeru/three-mmd/materials/physical'
import { MMDToonMaterial } from '@moeru/three-mmd/materials/toon'
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshDistanceMaterial,
  MeshPhongMaterial,
  Texture,
} from 'three'
import { describe, expect, it } from 'vitest'

import {
  applyMMDMaterialOpacity,
  applyMMDRenderMode,
  collectMMDMaterials,
  disposeMMDObject,
  prepareMMDMaterials,
  setMMDMaterialGlow,
} from './mmd-materials'

function createDescriptor(name: string, opacity = 1): MMDMaterialDescriptor {
  return {
    ambient: new Color(0.1, 0.2, 0.3),
    diffuse: new Color(0.4, 0.5, 0.6),
    doubleSided: false,
    fog: true,
    isDefaultToonTexture: true,
    name,
    opacity,
    outline: {
      alpha: 0.35,
      color: new Color(0.1, 0.1, 0.1),
      visible: true,
      width: 0.01,
    },
    shininess: 16,
    specular: new Color(0.2, 0.3, 0.4),
    toonMap: new Texture(),
    toonMapFileName: 'toon01.bmp',
  }
}

function countDisposals(resource: BufferGeometry | MeshBasicMaterial | MeshDepthMaterial | MeshDistanceMaterial | MMDToonMaterial | MMDPhysicalMaterial) {
  let count = 0
  resource.addEventListener('dispose', () => count++)
  return () => count
}

describe('mmd surface materials', () => {
  it('keeps generated outline materials out of the settings catalog and live controls', () => {
    const root = new Group()
    const surface = new MMDToonMaterial(createDescriptor('skin', 0.8))
    const outline = new MeshPhongMaterial({ opacity: 0.35, transparent: true })
    outline.name = 'skin:outline'
    const mesh = new Mesh(new BufferGeometry(), surface)
    mesh.add(new Mesh(mesh.geometry, outline))
    root.add(mesh)

    prepareMMDMaterials(root)
    setMMDMaterialGlow(root, 0.7)
    applyMMDMaterialOpacity(root, { 'skin': 0.4, 'skin:outline': 0.1 })

    expect(collectMMDMaterials(root)).toEqual([
      { index: 0, label: 'skin', name: 'skin', kind: 'skin' },
    ])
    expect(surface.emissiveIntensity).toBe(0.7)
    expect(surface.opacity).toBe(0.4)
    expect(surface.transparent).toBe(true)
    expect(outline.emissiveIntensity).toBe(1)
    expect(outline.opacity).toBe(0.35)
  })

  it('restores each surface material authored opacity and transparency', () => {
    const surface = new MMDToonMaterial(createDescriptor('glass', 0.6))
    const root = new Mesh(new BufferGeometry(), surface)

    applyMMDMaterialOpacity(root, { glass: 0.2 })
    applyMMDMaterialOpacity(root, {})

    expect(surface.opacity).toBe(0.6)
    expect(surface.transparent).toBe(true)
  })
})

/** A model with a face, hair, and a skirt, one material slot each. */
function createModel() {
  const materials = ['顔', '髪', 'スカート'].map(name => new MMDToonMaterial(createDescriptor(name)))
  const geometry = new BufferGeometry()
  materials.forEach((_, index) => geometry.addGroup(index * 3, 3, index))
  // The swap replaces the slots in place, so the mesh gets its own list.
  const mesh = new Mesh(geometry, [...materials])
  return { mesh, materials, slots: () => mesh.material as Array<MMDToonMaterial | MMDPhysicalMaterial> }
}

describe('applyMMDRenderMode', () => {
  it('shades every material except the face with a physical twin in hybrid mode', () => {
    const { mesh, materials, slots } = createModel()

    applyMMDRenderMode(mesh, 'hybrid')

    expect(slots()[0]).toBe(materials[0])
    expect(slots()[1]).toBeInstanceOf(MMDPhysicalMaterial)
    expect(slots()[2]).toBeInstanceOf(MMDPhysicalMaterial)
    expect((slots()[1] as MMDPhysicalMaterial).sheen).toBe(0.4)
  })

  it('puts the toon materials back in toon mode and reuses the twins later', () => {
    const { mesh, materials, slots } = createModel()

    applyMMDRenderMode(mesh, 'pbr')
    const twin = slots()[1]
    applyMMDRenderMode(mesh, 'toon')
    expect(slots()).toEqual(materials)

    applyMMDRenderMode(mesh, 'pbr')
    expect(slots()[1]).toBe(twin)
  })

  it('applies the owner kind and values by material index', () => {
    const { mesh, materials, slots } = createModel()

    applyMMDRenderMode(mesh, 'hybrid', { 1: { kind: 'metal', roughness: 0.05 }, 2: { kind: 'face' } })

    const hair = slots()[1] as MMDPhysicalMaterial
    expect(hair.metalness).toBe(1)
    expect(hair.roughness).toBe(0.05)
    expect(slots()[2]).toBe(materials[2])
  })

  // ROOT CAUSE:
  //
  // In Lat-style Miku, `huku3w.bmp` names both face skin and clothes. Keyed by name, a change to the clothes also
  // changed the face.
  //
  // We fixed this by keying the changes by material index.
  it('changes only the material at the index when two materials share a name', () => {
    const twins = [new MMDToonMaterial(createDescriptor('huku3w.bmp')), new MMDToonMaterial(createDescriptor('huku3w.bmp'))]
    const geometry = new BufferGeometry()
    twins.forEach((_, index) => geometry.addGroup(index * 3, 3, index))
    const mesh = new Mesh(geometry, [...twins])

    applyMMDRenderMode(mesh, 'pbr', { 1: { metalness: 1 } })

    const slots = mesh.material as Array<MMDToonMaterial | MMDPhysicalMaterial>
    expect(slots.map(material => material instanceof MMDPhysicalMaterial ? material.metalness : undefined)).toEqual([0, 1])
  })

  it('keeps the toon alpha, sides, and SDEF state on the twin', () => {
    const { mesh, materials, slots } = createModel()
    materials[1].side = DoubleSide
    materials[1].transparent = true
    materials[1].setSdefEnabled(false)

    applyMMDRenderMode(mesh, 'pbr')

    const hair = slots()[1] as MMDPhysicalMaterial
    expect(hair.side).toBe(DoubleSide)
    expect(hair.transparent).toBe(true)
    expect(hair.defines?.MMD_USE_SDEF).toBe(0)
  })

  it('keeps toon colors out of tone mapping', () => {
    const { mesh, materials } = createModel()

    applyMMDRenderMode(mesh, 'hybrid')

    expect(materials.every(material => !material.toneMapped)).toBe(true)
  })
})

describe('mmd GPU resource disposal', () => {
  it('disposes the materials of the other render mode', () => {
    const { mesh, materials, slots } = createModel()
    applyMMDRenderMode(mesh, 'pbr')
    const twin = slots()[1] as MMDPhysicalMaterial
    applyMMDRenderMode(mesh, 'toon')

    const twinDisposals = countDisposals(twin)
    const toonDisposals = countDisposals(materials[1])
    disposeMMDObject(mesh)

    expect(twinDisposals()).toBe(1)
    expect(toonDisposals()).toBe(1)
  })

  it('disposes shared geometry, render materials, and custom shadow materials once', () => {
    const geometry = new BufferGeometry()
    const surface = new MMDToonMaterial(createDescriptor('surface'))
    const outline = new MeshBasicMaterial()
    const depth = new MeshDepthMaterial()
    const distance = new MeshDistanceMaterial()
    const mesh = new Mesh(geometry, surface)
    mesh.customDepthMaterial = depth
    mesh.customDistanceMaterial = distance
    mesh.add(new Mesh(geometry, outline))

    const geometryDisposals = countDisposals(geometry)
    const surfaceDisposals = countDisposals(surface)
    const outlineDisposals = countDisposals(outline)
    const depthDisposals = countDisposals(depth)
    const distanceDisposals = countDisposals(distance)

    disposeMMDObject(mesh)

    expect(geometryDisposals()).toBe(1)
    expect(surfaceDisposals()).toBe(1)
    expect(outlineDisposals()).toBe(1)
    expect(depthDisposals()).toBe(1)
    expect(distanceDisposals()).toBe(1)
  })
})
