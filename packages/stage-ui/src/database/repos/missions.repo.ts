import type { MissionInstance } from '@proj-airi/core-agent'

import localforage from 'localforage'

/** One mission instance and the time of its last change. */
export interface MissionRecord {
  id: string
  mission: MissionInstance
  updatedAt: number
}

/** A removed mission stays as a tombstone with the time of the removal, so a later sync can remove it on other devices. */
interface MissionTombstone {
  id: string
  updatedAt: number
  deleted: true
}

type StoredMission = MissionRecord | MissionTombstone

const records = localforage.createInstance({ name: 'airi-missions', storeName: 'missions' })

/**
 * Runs one write. Every write of every window takes this lock. A change reads the stored mission inside the lock, so a
 * stop from Settings and a run of the leader never overwrite each other.
 */
function write<T>(run: () => Promise<T>) {
  return navigator.locks.request('airi:missions', run)
}

/** A mission can hold reactive arrays that IndexedDB cannot clone, so each record goes in as a JSON copy. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

/** The mission instances on this device, one record for each instance, keyed by the mission id. */
export const missionsRepo = {
  /** The missions that are not removed, oldest first. */
  async list() {
    const stored: StoredMission[] = []
    await records.iterate<StoredMission, void>((record) => {
      stored.push(record)
    })
    return stored
      .filter((record): record is MissionRecord => !('deleted' in record))
      .sort((left, right) => left.mission.createdAt - right.mission.createdAt)
  },
  async add(mission: MissionInstance) {
    await write(() => records.setItem<MissionRecord>(mission.id, plain({ id: mission.id, mission, updatedAt: mission.updatedAt })))
  },
  /**
   * Changes one mission from its stored value. `next` returns the new mission, or `undefined` to keep the stored one.
   * A removed mission stays removed. Resolves to the stored mission after the change.
   */
  async change(id: string, next: (stored: MissionInstance) => MissionInstance | undefined) {
    return write(async () => {
      const stored = await records.getItem<StoredMission>(id)
      if (!stored || 'deleted' in stored)
        return undefined
      const mission = next(stored.mission)
      if (!mission)
        return stored.mission
      await records.setItem<MissionRecord>(id, plain({ id, mission, updatedAt: mission.updatedAt }))
      return mission
    })
  },
  /** Replaces each mission with a tombstone. */
  async remove(ids: string[], updatedAt: number) {
    await write(() => Promise.all(ids.map(id => records.setItem<MissionTombstone>(id, { id, updatedAt, deleted: true }))))
  },
  /** Deletes every record, tombstones too. Only deleting all data uses it. */
  async clear() {
    await write(() => records.clear())
  },
}
