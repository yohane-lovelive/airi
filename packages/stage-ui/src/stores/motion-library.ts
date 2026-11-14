import type { GestureClipSource, GestureDefinition } from '@proj-airi/stage-shared/body-motion'

import type { GeneratedMotionRecord, ImportedMotionRecord, MotionRecord } from '../database/repos/motions.repo'

import { errorMessageFrom } from '@moeru/std'
import { BUILT_IN_GESTURES, gestureFromGeneratedTracks, gestureGroupOfHumanBone, matchGesture } from '@proj-airi/stage-shared/body-motion'
import { useBroadcastChannel } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { motionsRepo } from '../database/repos/motions.repo'

/** One clip of the library, as a renderer and Settings see it. */
export interface MotionEntry {
  id: string
  source: 'built-in' | 'imported' | 'generated'
  name: string
  description: string
  tags: readonly string[]
  part: 'upper' | 'full'
  duration: number
  /** The VRM humanoid bones that the clip rotates. */
  bones: readonly string[]
  useCount: number
  enabled: boolean
  /** Whether the owner kept a generated clip. Other clips are always kept. */
  kept: boolean
}

/** The longest name of a generated clip. Its description keeps the whole motion. */
const GENERATED_NAME_LENGTH = 40

/** A request of Settings to play a clip on the stage. `at` tells two requests for the same clip apart. */
export interface MotionPreviewRequest {
  id: string
  at: number
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
    kept: true,
  }
}

function importedEntry(record: ImportedMotionRecord): MotionEntry {
  const { vrma: _vrma, updatedAt: _updatedAt, ...entry } = record
  return { ...entry, kept: true }
}

function generatedEntry(record: GeneratedMotionRecord): MotionEntry {
  const { vrma: _vrma, gesture: _gesture, updatedAt: _updatedAt, ...entry } = record
  return entry
}

/**
 * The motion library: the built-in gestures, the `.vrma` clips that the owner imported, and the generated clips.
 *
 * - A built-in gesture lives in the code. IndexedDB keeps only its use count and whether the owner turned it off.
 * - An imported clip keeps its `.vrma` data in IndexedDB.
 * - A generated clip keeps its `.vrma` data and the gesture of the upper body that plays. The owner keeps or removes it.
 * - {@link choose} finds the clip for the free-text `motion` of an `ACT` marker.
 *
 * Use when:
 * - The stage plays a gesture for a marker, or Settings lists the clips.
 */
export const useMotionLibraryStore = defineStore('motion-library', () => {
  const records = ref<MotionRecord[]>([])
  let pendingLoad: Promise<void> | undefined
  // Settings changes the library in its own window, so each change tells the other windows to read it again.
  const { data: changed, post: postChange } = useBroadcastChannel<number, number>({ name: 'airi:motions' })
  // The preview of Settings plays on the stage, which is another window on the desktop.
  const { data: previewRequest, post: postPreview } = useBroadcastChannel<MotionPreviewRequest, MotionPreviewRequest>({ name: 'airi:motion-preview' })
  watch(changed, () => void load())
  // The system prompt lists the clips that the owner left on, so the library reads its records at once.
  void load().catch(error => console.warn('[motion-library] Failed to read the library:', errorMessageFrom(error)))

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
    const generated = records.value.filter((record): record is GeneratedMotionRecord => record.source === 'generated').map(generatedEntry)
    return [...builtIn, ...imported, ...generated]
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
      return gesture && { kind: 'keys', id: entry.id, part: 'upper', gesture }
    }
    const record = await motionsRepo.get(entry.id)
    if (record?.source === 'generated')
      return { kind: 'keys', id: entry.id, part: 'upper', gesture: record.gesture }
    return record?.source === 'imported' ? { kind: 'vrma', id: entry.id, part: record.part, vrma: record.vrma } : undefined
  }

  async function change(id: string, next: (stored: MotionRecord | undefined) => MotionRecord | undefined) {
    const record = await motionsRepo.change(id, next)
    if (record)
      records.value = [...records.value.filter(stored => stored.id !== id), record]
    postChange(Date.now())
  }

  /** Asks the stage of another window to play a clip, for the preview of Settings. */
  function requestPreview(id: string) {
    postPreview({ id, at: Date.now() })
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
    // The loader brings three.js, so it loads only for an import.
    const { loadVRMAnimation } = await import('@proj-airi/stage-ui-three/composables/vrm')
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
    postChange(Date.now())
    return importedEntry(record)
  }

  /**
   * Adds a clip of the motion generator. The upper body of the clip plays, so the hips and the legs stay with the idle.
   *
   * @param motion The text that the clip shows, for example the `motion` of a marker. It becomes the description, and
   * the whole text becomes a tag, so the same motion chooses the clip again.
   * @param vrma The `.vrma` data of the generator.
   * @returns the new entry, or undefined when the file holds no motion of the upper body.
   */
  async function addGenerated(motion: string, vrma: ArrayBuffer) {
    const { loadVRMAnimation } = await import('@proj-airi/stage-ui-three/composables/vrm')
    const url = URL.createObjectURL(new Blob([vrma]))
    const animation = await loadVRMAnimation(url).finally(() => URL.revokeObjectURL(url))
    if (!animation)
      return undefined

    const text = motion.trim()
    const about = { id: nanoid(), description: text, tags: [text.toLowerCase()] }
    const tracks = [...animation.humanoidTracks.rotation].map(([bone, track]) => ({ bone, times: [...track.times], values: [...track.values] }))
    const gesture = gestureFromGeneratedTracks(about, tracks, animation.duration)
    if (!gesture)
      return undefined

    const record: GeneratedMotionRecord = {
      id: about.id,
      source: 'generated',
      name: text.length > GENERATED_NAME_LENGTH ? `${text.slice(0, GENERATED_NAME_LENGTH - 1)}…` : text,
      description: text,
      tags: about.tags,
      part: 'upper',
      duration: gesture.duration,
      bones: Object.keys(gesture.tracks),
      gesture,
      vrma,
      kept: false,
      useCount: 0,
      enabled: true,
      updatedAt: Date.now(),
    }
    await motionsRepo.put(record)
    records.value = [...records.value, record]
    postChange(Date.now())
    return generatedEntry(record)
  }

  /** Keeps a generated clip, so Settings no longer asks the owner about it. */
  async function keep(id: string) {
    await ready()
    await change(id, stored => stored?.source === 'generated' ? { ...stored, kept: true, updatedAt: Date.now() } : undefined)
  }

  /** Removes an imported or generated clip. A built-in gesture stays, and Settings turns it off instead. */
  async function remove(id: string) {
    const record = records.value.find(stored => stored.id === id)
    if (record?.source !== 'imported' && record?.source !== 'generated')
      return
    await motionsRepo.remove(id)
    records.value = records.value.filter(stored => stored.id !== id)
    postChange(Date.now())
  }

  async function resetState() {
    await motionsRepo.clear()
    records.value = []
    postChange(Date.now())
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
    addGenerated,
    keep,
    remove,
    resetState,
    requestPreview,
    /** The last preview that another window asked for. */
    previewRequest,
  }
})
