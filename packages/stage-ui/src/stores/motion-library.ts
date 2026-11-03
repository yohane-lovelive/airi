import type { GestureClipSource, GestureDefinition } from '@proj-airi/stage-shared/body-motion'

import type { ImportedMotionRecord, MotionRecord } from '../database/repos/motions.repo'

import { BUILT_IN_GESTURES, gestureGroupOfHumanBone, matchGesture } from '@proj-airi/stage-shared/body-motion'
import { loadVRMAnimation } from '@proj-airi/stage-ui-three/composables/vrm'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { motionsRepo } from '../database/repos/motions.repo'

/** One clip of the library, as a renderer and Settings see it. */
export interface MotionEntry {
  id: string
  source: 'built-in' | 'imported'
  name: string
  description: string
  tags: readonly string[]
  part: 'upper' | 'full'
  duration: number
  /** The VRM humanoid bones that the clip rotates. */
  bones: readonly string[]
  useCount: number
  enabled: boolean
}

function builtInEntry(gesture: GestureDefinition, record: MotionRecord | undefined): MotionEntry {
  return {
    id: gesture.id,
    source: 'built-in',
    name: gesture.id,
    description: gesture.description,
    tags: gesture.tags,
    part: 'upper',
    duration: gesture.duration,
    bones: Object.keys(gesture.tracks),
    useCount: record?.useCount ?? 0,
    enabled: record?.enabled ?? true,
  }
}

function importedEntry(record: ImportedMotionRecord): MotionEntry {
  const { vrma: _vrma, updatedAt: _updatedAt, ...entry } = record
  return entry
}

/**
 * The motion library: the built-in gestures and the `.vrma` clips that the owner imported.
 *
 * - A built-in gesture lives in the code. IndexedDB keeps only its use count and whether the owner turned it off.
 * - An imported clip keeps its `.vrma` data in IndexedDB.
 * - {@link choose} finds the clip for the free-text `motion` of an `ACT` marker.
 *
 * Use when:
 * - The stage plays a gesture for a marker, or Settings lists the clips.
 */
export const useMotionLibraryStore = defineStore('motion-library', () => {
  const records = ref<MotionRecord[]>([])
  let pendingLoad: Promise<void> | undefined

  function load() {
    pendingLoad = (async () => {
      records.value = await motionsRepo.list()
    })()
    return pendingLoad
  }

  function ready() {
    return pendingLoad ?? load()
  }

  const entries = computed<MotionEntry[]>(() => {
    const byId = new Map(records.value.map(record => [record.id, record]))
    const builtIn = BUILT_IN_GESTURES.map(gesture => builtInEntry(gesture, byId.get(gesture.id)))
    const imported = records.value.filter((record): record is ImportedMotionRecord => record.source === 'imported').map(importedEntry)
    return [...builtIn, ...imported]
  })

  /**
   * The enabled clip that fits `motion`. `supports` tells whether the current model can play a clip, for example
   * whether it has the bones.
   */
  function choose(motion: string, supports: (entry: MotionEntry) => boolean = () => true) {
    const candidates = entries.value.filter(entry => entry.enabled && supports(entry))
    const id = matchGesture(motion, candidates)
    return candidates.find(entry => entry.id === id)
  }

  async function sourceOf(entry: MotionEntry): Promise<GestureClipSource | undefined> {
    if (entry.source === 'built-in') {
      const gesture = BUILT_IN_GESTURES.find(candidate => candidate.id === entry.id)
      return gesture && { kind: 'built-in', id: entry.id, part: 'upper', gesture }
    }
    const record = await motionsRepo.get(entry.id)
    return record?.source === 'imported' ? { kind: 'vrma', id: entry.id, part: record.part, vrma: record.vrma } : undefined
  }

  async function change(id: string, next: (stored: MotionRecord | undefined) => MotionRecord | undefined) {
    const record = await motionsRepo.change(id, next)
    if (record)
      records.value = [...records.value.filter(stored => stored.id !== id), record]
  }

  /** Counts one play of a clip. */
  async function recordUse(id: string) {
    await ready()
    await change(id, stored => stored
      ? { ...stored, useCount: stored.useCount + 1, updatedAt: Date.now() }
      : { id, source: 'built-in', useCount: 1, enabled: true, updatedAt: Date.now() })
  }

  async function setEnabled(id: string, enabled: boolean) {
    await ready()
    await change(id, stored => stored
      ? { ...stored, enabled, updatedAt: Date.now() }
      : { id, source: 'built-in', useCount: 0, enabled, updatedAt: Date.now() })
  }

  /**
   * Adds a `.vrma` file to the library. It reads the duration and the bones of the clip.
   *
   * @returns the new entry, or undefined when the file holds no VRM animation.
   */
  async function importVrma(file: { name: string, vrma: ArrayBuffer }, about: { description: string, tags: string[] }) {
    const url = URL.createObjectURL(new Blob([file.vrma]))
    const animation = await loadVRMAnimation(url).finally(() => URL.revokeObjectURL(url))
    if (!animation)
      return undefined

    const bones = [...animation.humanoidTracks.rotation.keys()]
    const movesLegs = animation.humanoidTracks.translation.size > 0 || bones.some(bone => !gestureGroupOfHumanBone(bone) && bone !== 'leftEye' && bone !== 'rightEye')
    const record: ImportedMotionRecord = {
      id: nanoid(),
      source: 'imported',
      name: file.name,
      description: about.description,
      tags: about.tags,
      part: movesLegs ? 'full' : 'upper',
      duration: animation.duration,
      bones,
      vrma: file.vrma,
      useCount: 0,
      enabled: true,
      updatedAt: Date.now(),
    }
    await motionsRepo.put(record)
    records.value = [...records.value, record]
    return importedEntry(record)
  }

  /** Removes an imported clip. A built-in gesture stays, and Settings turns it off instead. */
  async function remove(id: string) {
    const record = records.value.find(stored => stored.id === id)
    if (record?.source !== 'imported')
      return
    await motionsRepo.remove(id)
    records.value = records.value.filter(stored => stored.id !== id)
  }

  async function resetState() {
    await motionsRepo.clear()
    records.value = []
  }

  return {
    entries,
    ready,
    reload: load,
    choose,
    sourceOf,
    recordUse,
    setEnabled,
    importVrma,
    remove,
    resetState,
  }
})
