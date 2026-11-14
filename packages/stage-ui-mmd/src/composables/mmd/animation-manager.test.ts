import type { MMDUpdateOptions, PhysicsFactory } from '@moeru/three-mmd'
import type { AnimationMixer } from 'three'

import { MMD, PmxObject } from '@moeru/three-mmd'
import {
  AnimationClip,
  Bone,
  BufferGeometry,
  MeshBasicMaterial,
  Quaternion,
  QuaternionKeyframeTrack,
  Skeleton,
  SkinnedMesh,
  Vector3,
} from 'three'
import { describe, expect, it } from 'vitest'

import { createMMDAnimationManager } from './animation-manager'

function createPmx(): PmxObject {
  return {
    bones: [],
    displayFrames: [],
    header: {
      additionalVec4Count: 0,
      boneIndexSize: 4,
      comment: '',
      encoding: PmxObject.Header.Encoding.Utf8,
      englishComment: '',
      englishModelName: '',
      materialIndexSize: 4,
      modelName: '',
      morphIndexSize: 4,
      rigidBodyIndexSize: 4,
      signature: 'PMX',
      textureIndexSize: 4,
      version: 2,
      vertexIndexSize: 4,
    },
    indices: new Uint8Array(),
    joints: [],
    materials: [],
    morphs: [],
    rigidBodies: [],
    softBodies: [],
    textures: [],
    vertices: [],
  }
}

class RecordingMMD extends MMD {
  disposed = false
  gravity = new Vector3()
  mixer?: AnimationMixer
  updates: MMDUpdateOptions[] = []

  constructor(boneNames: string[] = []) {
    const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial())
    const bones = boneNames.map((name) => {
      const bone = new Bone()
      bone.name = name
      mesh.add(bone)
      return bone
    })
    mesh.bind(new Skeleton(bones))
    super(createPmx(), mesh)
  }

  bone(name: string) {
    return this.mesh.skeleton.bones.find(bone => bone.name === name)!
  }

  override setPhysics(_createPhysics: PhysicsFactory): void {
    this.physics = {
      createHelper: () => {
        throw new Error('No physics helper is used by this test runtime')
      },
      setGravity: gravity => this.gravity.copy(gravity),
      update: () => {},
    }
  }

  override updateWithMixer(delta: number, mixer: AnimationMixer, options: MMDUpdateOptions = {}): void {
    this.mixer = mixer
    this.updates.push({ ...options })
    mixer.update(delta)
  }

  override dispose(): void {
    this.disposed = true
    super.dispose()
  }
}

describe('createMMDAnimationManager', () => {
  it('forwards runtime feature gates, gravity, and disposal to MMD', async () => {
    const mmd = new RecordingMMD()
    const manager = createMMDAnimationManager(mmd, { physicsEnabled: false })

    manager.setGravity(3.5)
    manager.setIKEnabled(false)
    await manager.init()
    manager.update(1 / 60)

    expect(mmd.gravity.toArray()).toEqual([0, -3.5, 0])
    expect(mmd.updates).toEqual([
      { grant: true, ik: false, physics: false },
    ])

    manager.setPhysicsEnabled(true)
    manager.setGrantEnabled(false)
    manager.update(1 / 30)

    expect(mmd.updates[1]).toEqual({ grant: false, ik: false, physics: true })

    manager.dispose()
    manager.update(1)

    expect(mmd.disposed).toBe(true)
    expect(mmd.updates).toHaveLength(2)
  })

  it('returns a completed one-shot action to the configured idle motion', async () => {
    const mmd = new RecordingMMD()
    const manager = createMMDAnimationManager(mmd)
    const idle = new AnimationClip('idle', 1, [])
    const gesture = new AnimationClip('gesture', 0.1, [])

    manager.registerClip('idle', idle)
    manager.registerClip('gesture', gesture)
    await manager.init()
    manager.setIdleMotion('idle', 0)
    manager.playAction('gesture', { crossfade: 0 })
    manager.update(0.2)

    const idleAction = mmd.mixer?.existingAction(idle)
    const gestureAction = mmd.mixer?.existingAction(gesture)
    expect(idleAction?.isRunning()).toBe(true)
    expect(gestureAction?.isRunning()).toBe(false)
  })

  it('plays a gesture over the parts that it moves, and gives them back to the idle when it ends', async () => {
    const mmd = new RecordingMMD(['頭', '左腕'])
    const manager = createMMDAnimationManager(mmd)
    const turn = (angle: number) => new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), angle)
    const hold = (bone: string, angle: number, duration: number) =>
      new QuaternionKeyframeTrack(`.bones[${bone}].quaternion`, [0, duration], [...turn(angle).toArray(), ...turn(angle).toArray()])
    const idle = new AnimationClip('idle', 2, [hold('頭', 0.1, 2), hold('左腕', 0.3, 2)])
    const nod = new AnimationClip('nod', 0.5, [hold('頭', 0.6, 0.5)])
    const angleOf = (bone: string) => 2 * Math.acos(Math.min(1, Math.abs(mmd.bone(bone).quaternion.w)))

    manager.registerClip('idle', idle)
    await manager.init()
    manager.setIdleMotion('idle', 0)
    manager.update(0.1)
    expect(angleOf('頭')).toBeCloseTo(0.1, 5)

    expect(manager.playGesture(nod, 0)).toBe(true)
    manager.update(0.1)
    expect(angleOf('頭')).toBeCloseTo(0.6, 5)
    expect(angleOf('左腕')).toBeCloseTo(0.3, 5)

    manager.update(0.6)
    manager.update(0.1)
    expect(angleOf('頭')).toBeCloseTo(0.1, 5)
    expect(angleOf('左腕')).toBeCloseTo(0.3, 5)
  })

  it('skips a gesture while a motion of the whole body plays', async () => {
    const mmd = new RecordingMMD(['頭'])
    const manager = createMMDAnimationManager(mmd)
    manager.registerClip('dance', new AnimationClip('dance', 5, []))
    await manager.init()

    manager.playAction('dance', { crossfade: 0 })

    expect(manager.playGesture(new AnimationClip('nod', 0.5, [new QuaternionKeyframeTrack('.bones[頭].quaternion', [0], [0, 0, 0, 1])]))).toBe(false)
  })
})
