import type { Timeline } from '@proj-airi/core-agent'

/** In-memory timelines for Node tests, which have no IndexedDB. */
const records = new Map<string, Timeline>()

export const timelineRepo = {
  async get(sessionId: string) {
    return records.get(sessionId)
  },
  async change(sessionId: string, next: (stored: Timeline | undefined) => Timeline) {
    const timeline = next(records.get(sessionId))
    records.set(sessionId, timeline)
    return timeline
  },
  async remove(sessionId: string) {
    records.delete(sessionId)
  },
  async clear() {
    records.clear()
  },
}
