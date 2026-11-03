import localforage from 'localforage'

/**
 * The record of one clip of the motion library.
 *
 * A built-in gesture keeps only the choices of the owner and its use count. Its keys stay in the code of
 * `@proj-airi/stage-shared/body-motion`. An imported clip keeps its `.vrma` data and the facts about it.
 */
export type MotionRecord = BuiltInMotionRecord | ImportedMotionRecord

interface MotionRecordBase {
  id: string
  useCount: number
  /** Whether a marker can choose the clip. The owner turns it off in Settings. */
  enabled: boolean
  updatedAt: number
}

export interface BuiltInMotionRecord extends MotionRecordBase {
  source: 'built-in'
}

export interface ImportedMotionRecord extends MotionRecordBase {
  source: 'imported'
  name: string
  description: string
  tags: string[]
  /** `upper` when the clip moves no hips or legs. */
  part: 'upper' | 'full'
  duration: number
  /** The VRM humanoid bones that the clip rotates. */
  bones: string[]
  vrma: ArrayBuffer
}

const records = localforage.createInstance({ name: 'airi-motions', storeName: 'motions' })

function write<T>(run: () => Promise<T>) {
  return navigator.locks.request('airi:motions', run)
}

/** The clips of the motion library on this device, one record for each clip, keyed by the clip id. */
export const motionsRepo = {
  async list() {
    const stored: MotionRecord[] = []
    await records.iterate<MotionRecord, void>((record) => {
      stored.push(record)
    })
    return stored
  },
  async get(id: string) {
    return await records.getItem<MotionRecord>(id) ?? undefined
  },
  async put(record: MotionRecord) {
    await write(() => records.setItem(record.id, record))
  },
  /** Changes one stored record. `next` gets the stored record, or undefined for a built-in gesture without a record yet. */
  async change(id: string, next: (stored: MotionRecord | undefined) => MotionRecord | undefined) {
    return write(async () => {
      const record = next(await records.getItem<MotionRecord>(id) ?? undefined)
      if (record)
        await records.setItem(id, record)
      return record
    })
  },
  async remove(id: string) {
    await write(() => records.removeItem(id))
  },
  async clear() {
    await write(() => records.clear())
  },
}
