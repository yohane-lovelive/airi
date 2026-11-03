import { BUILT_IN_GESTURES } from '@proj-airi/stage-shared/body-motion'
import { animations } from '@proj-airi/stage-ui-three/assets/vrm'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { motionsRepo } from '../database/repos/motions.repo'
import { useMotionLibraryStore } from './motion-library'

describe('motion library store', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(async () => {
    await motionsRepo.clear()
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(async () => {
    disposePinia(pinia)
    await motionsRepo.clear()
  })

  it('lists the built-in gestures, and keeps their use count and the choice of the owner', async () => {
    const library = useMotionLibraryStore()
    await library.ready()
    expect(library.entries.map(entry => entry.id)).toEqual(BUILT_IN_GESTURES.map(gesture => gesture.id))

    await library.recordUse('nod')
    await library.recordUse('nod')
    await library.setEnabled('wave', false)

    const again = useMotionLibraryStore(createPinia())
    await again.ready()
    expect(again.entries.find(entry => entry.id === 'nod')).toMatchObject({ useCount: 2, enabled: true })
    expect(again.entries.find(entry => entry.id === 'wave')?.enabled).toBe(false)
  })

  it('chooses an enabled clip that the model supports, and gives its keys to the renderer', async () => {
    const library = useMotionLibraryStore()
    await library.ready()

    expect(library.choose('waves hello')?.id).toBe('wave')
    expect(library.choose('waves hello', entry => !entry.bones.includes('rightLowerArm'))).toBeUndefined()

    await library.setEnabled('wave', false)
    expect(library.choose('waves hello')).toBeUndefined()

    const source = await library.sourceOf(library.entries.find(entry => entry.id === 'nod')!)
    expect(source).toMatchObject({ kind: 'built-in', id: 'nod', part: 'upper' })
  })

  it('imports a .vrma file with its duration and bones, chooses it by its tags, and removes it', async () => {
    const library = useMotionLibraryStore()
    await library.ready()
    const vrma = await (await fetch(animations.idleLoop.toString())).arrayBuffer()

    const entry = await library.importVrma({ name: 'idle_loop.vrma', vrma }, { description: 'Stands and breathes.', tags: ['stand', '待機'] })

    expect(entry).toMatchObject({ source: 'imported', name: 'idle_loop.vrma', part: 'full' })
    expect(entry!.duration).toBeGreaterThan(0)
    expect(entry!.bones).toContain('hips')
    expect(library.choose('しばらく待機する')?.id).toBe(entry!.id)
    expect(await library.sourceOf(entry!)).toMatchObject({ kind: 'vrma', part: 'full' })

    await library.remove(entry!.id)
    expect(library.entries.some(stored => stored.id === entry!.id)).toBe(false)
  })
})
