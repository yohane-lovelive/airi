import { IRODORI_CLIP_EXTENSIONS, IRODORI_CLIP_ID_PREFIX } from './server'

/** The author measured most of the speaker likeness at about this many seconds of reference. */
export const IRODORI_RECOMMENDED_REFERENCE_SECONDS = 30

/** v4 Small and its fine-tunes join at most this many seconds. The server cuts the rest. */
export const IRODORI_MAX_REFERENCE_SECONDS = 120

/**
 * Builds the server voice id of a clip. The server accepts only letters, digits, `-`, and `_`.
 *
 * Each clip gets its own suffix, so a clip that the owner adds again after a delete
 * never meets the old file on the server.
 */
export function irodoriClipIdFor(voiceId: string, suffix: string) {
  return `${IRODORI_CLIP_ID_PREFIX}${voiceId}-${suffix}`.replace(/[^\w-]/g, '_')
}

/** Tells whether the server accepts a file with this name as a clip. */
export function isIrodoriClipFile(fileName: string) {
  const name = fileName.toLowerCase()
  return IRODORI_CLIP_EXTENSIONS.some(extension => name.endsWith(extension))
}

/** Returns a copy of the clips with one clip moved by `offset`. An offset past an end changes nothing. */
export function moveIrodoriClip<T>(clips: readonly T[], index: number, offset: number): T[] {
  const target = index + offset
  const next = [...clips]
  if (index < 0 || index >= clips.length || target < 0 || target >= clips.length)
    return next

  const [clip] = next.splice(index, 1)
  next.splice(target, 0, clip)
  return next
}

/** Adds the measured lengths of the clips. */
export function irodoriReferenceSeconds(clips: ReadonlyArray<{ seconds?: number }>) {
  return clips.reduce((total, clip) => total + (clip.seconds ?? 0), 0)
}
