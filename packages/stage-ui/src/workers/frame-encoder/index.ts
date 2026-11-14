import type { CapturedFrame } from '../../libs/perception/frame-ring'

import { encodeFrame, encodeScreenFrame } from '../../libs/perception/encode-frame'

interface EncoderAnswer { id: number, frame?: CapturedFrame, image?: Blob, error?: string }

/**
 * Encodes captured bitmaps into frames off the page thread, so the stage keeps its frame rate.
 * Where no `Worker` exists, the page encodes the bitmap itself. `dispose` ends the worker.
 */
export class FrameEncoder {
  private worker?: Worker
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (answer: EncoderAnswer) => void, reject: (error: Error) => void }>()

  /** Encodes one bitmap. The bitmap moves to the worker, so the caller must not use it after the call. */
  async encode(bitmap: ImageBitmap, at: number): Promise<CapturedFrame> {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined')
      return encodeFrame(bitmap, at)
    const answer = await this.post({ bitmap, at })
    if (!answer.frame)
      throw new Error('The frame encoder gave no frame.')
    return answer.frame
  }

  /**
   * Encodes one bitmap for the screen of a sidecar room, as a smaller JPEG with no thumbnail. The bitmap moves to the
   * worker, so the caller must not use it after the call.
   */
  async encodeScreen(bitmap: ImageBitmap): Promise<Blob> {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined')
      return encodeScreenFrame(bitmap)
    const answer = await this.post({ bitmap, at: 0, kind: 'screen' })
    if (!answer.image)
      throw new Error('The frame encoder gave no image.')
    return answer.image
  }

  dispose() {
    this.worker?.terminate()
    this.worker = undefined
    for (const { reject } of this.pending.values())
      reject(new Error('The frame encoder stopped.'))
    this.pending.clear()
  }

  private post(request: { bitmap: ImageBitmap, at: number, kind?: 'screen' }) {
    const worker = this.worker ??= this.createWorker()
    const id = this.nextId++
    return new Promise<EncoderAnswer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({ id, ...request }, [request.bitmap])
    })
  }

  private createWorker() {
    const worker = new Worker(new URL('./frame-encoder.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (event: MessageEvent<EncoderAnswer>) => {
      const waiting = this.pending.get(event.data.id)
      if (!waiting)
        return
      this.pending.delete(event.data.id)
      if (event.data.error)
        waiting.reject(new Error(event.data.error))
      else
        waiting.resolve(event.data)
    })
    return worker
  }
}
