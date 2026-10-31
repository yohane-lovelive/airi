import type { MissionInstance } from '@proj-airi/core-agent'

import type { MissionRecord } from '../missions.repo'

/** In-memory missions for Node tests, which have no IndexedDB. */
const records = new Map<string, MissionRecord>()

export const missionsRepo = {
  async list() {
    return [...records.values()].sort((left, right) => left.mission.createdAt - right.mission.createdAt)
  },
  async add(mission: MissionInstance) {
    records.set(mission.id, { id: mission.id, mission, updatedAt: mission.updatedAt })
  },
  async change(id: string, next: (stored: MissionInstance) => MissionInstance | undefined) {
    const stored = records.get(id)
    if (!stored)
      return undefined
    const mission = next(stored.mission)
    if (!mission)
      return stored.mission
    records.set(id, { id, mission, updatedAt: mission.updatedAt })
    return mission
  },
  async remove(ids: string[]) {
    for (const id of ids)
      records.delete(id)
  },
  async clear() {
    records.clear()
  },
}
