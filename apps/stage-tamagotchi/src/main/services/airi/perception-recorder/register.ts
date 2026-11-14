import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type { PerceptionRecorderService } from '.'

import { mkdir } from 'node:fs/promises'

import { defineInvokeHandler } from '@moeru/eventa'
import { shell } from 'electron'

import { electronPerceptionRecorder } from '../../../../shared/eventa'

/** Answers the screen recorder calls of one window. The recorder is shared, so one recording runs for all windows. */
export function registerPerceptionRecorder(
  context: ReturnType<typeof createContext>['context'],
  service: PerceptionRecorderService,
): () => void {
  const disposers = [
    defineInvokeHandler(context, electronPerceptionRecorder.start, () => service.start()),
    defineInvokeHandler(context, electronPerceptionRecorder.appendFrame, ({ id, frame }) => service.appendFrame(id, frame)),
    defineInvokeHandler(context, electronPerceptionRecorder.appendEvents, ({ id, events }) => service.appendEvents(id, events)),
    defineInvokeHandler(context, electronPerceptionRecorder.stop, () => service.stop('owner')),
    defineInvokeHandler(context, electronPerceptionRecorder.list, () => service.list()),
    defineInvokeHandler(context, electronPerceptionRecorder.remove, ({ id }) => service.remove(id)),
    defineInvokeHandler(context, electronPerceptionRecorder.openFolder, async () => {
      await mkdir(service.directory, { recursive: true })
      await shell.openPath(service.directory)
    }),
  ]

  return () => disposers.forEach(dispose => dispose())
}
