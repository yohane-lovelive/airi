import type { Timeline } from '@proj-airi/core-agent'

import localforage from 'localforage'

const records = localforage.createInstance({ name: 'airi-timeline', storeName: 'timelines' })

/** Runs one write. Every window takes this lock, so two changes of one timeline never overwrite each other. */
function write<T>(run: () => Promise<T>) {
  return navigator.locks.request('airi:timeline', run)
}

/** A timeline can hold reactive arrays that IndexedDB cannot clone, so each record goes in as a JSON copy. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

/**
 * The screen timeline of each conversation, keyed by the session id. It stays on the device and never syncs, because
 * it describes the owner's screen.
 */
export const timelineRepo = {
  async get(sessionId: string) {
    return await records.getItem<Timeline>(sessionId) ?? undefined
  },
  /** Changes one timeline from its stored value. `next` returns the new timeline. Resolves to it. */
  async change(sessionId: string, next: (stored: Timeline | undefined) => Timeline) {
    return write(async () => {
      const timeline = next(await records.getItem<Timeline>(sessionId) ?? undefined)
      await records.setItem<Timeline>(sessionId, plain(timeline))
      return timeline
    })
  },
  async remove(sessionId: string) {
    await write(() => records.removeItem(sessionId))
  },
  async clear() {
    await write(() => records.clear())
  },
}
