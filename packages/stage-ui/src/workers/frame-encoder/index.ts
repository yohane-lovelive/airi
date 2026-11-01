import type { CapturedFrame } from '../../libs/perception/frame-ring'

import { encodeFrame } from '../../libs/perception/encode-frame'

/**
 * Encodes captured bitmaps into frames off the page thread, so the stage keeps its frame rate.
 * Where no `Worker` exists, the page encodes the bitmap itself. `dispose` ends the worker.
 */
export class FrameEncoder {
  private worker?: Worker
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (frame: CapturedFrame) => void, reject: (error: Error) => void }>()

  /** Encodes one bitmap. The bitmap moves to the worker, so the caller must not use it after the call. */
  encode(bitmap: ImageBitmap, at: number): Promise<CapturedFrame> {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined')
      return encodeFrame(bitmap, at)
    const worker = this.worker ??= this.createWorker()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({ id, bitmap, at }, [bitmap])
    })
  }

  dispose() {
    this.worker?.terminate()
    this.worker = undefined
    for (const { reject } of this.pending.values())
      reject(new Error('The frame encoder stopped.'))
    this.pending.clear()
  }

  private createWorker() {
    const worker = new Worker(new URL('./frame-encoder.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (event: MessageEvent<{ id: number, frame?: CapturedFrame, error?: string }>) => {
      const waiting = this.pending.get(event.data.id)
      if (!waiting)
        return
      this.pending.delete(event.data.id)
      if (event.data.frame)
        waiting.resolve(event.data.frame)
      else
        waiting.reject(new Error(event.data.error ?? 'The frame encoder failed.'))
    })
    return worker
  }
}
