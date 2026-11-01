import type { useElectronEventaContext } from '@proj-airi/electron-vueuse'
import type { PerceptionRecorderSink } from '@proj-airi/stage-ui/libs/perception/recorder'

import { defineInvoke } from '@moeru/eventa'

import { electronPerceptionRecorder } from '../../shared/eventa'

/** Lets the screen recorder write recordings through the main process, into the user data folder of the app. */
export function createElectronPerceptionRecorder(context: ReturnType<typeof useElectronEventaContext>['value']): PerceptionRecorderSink {
  const start = defineInvoke(context, electronPerceptionRecorder.start)
  const appendFrame = defineInvoke(context, electronPerceptionRecorder.appendFrame)
  const appendEvents = defineInvoke(context, electronPerceptionRecorder.appendEvents)
  const stop = defineInvoke(context, electronPerceptionRecorder.stop)
  const list = defineInvoke(context, electronPerceptionRecorder.list)
  const remove = defineInvoke(context, electronPerceptionRecorder.remove)
  const openFolder = defineInvoke(context, electronPerceptionRecorder.openFolder)
  return {
    start: () => start(),
    appendFrame: (id, frame) => appendFrame({ id, frame: { ...frame } }),
    appendEvents: (id, events) => appendEvents({ id, events: events.map(event => ({ ...event })) }),
    stop: () => stop(),
    list: () => list(),
    remove: id => remove({ id }),
    openFolder: () => openFolder(),
  }
}
