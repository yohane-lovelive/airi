import { errorMessageFrom } from '@moeru/std'

import { encodeFrame } from '../../libs/perception/encode-frame'

/** Encodes each bitmap that the page sends, and answers with the frame under the same id. */
globalThis.addEventListener('message', async (event: MessageEvent<{ id: number, bitmap: ImageBitmap, at: number }>) => {
  const { id, bitmap, at } = event.data
  try {
    const frame = await encodeFrame(bitmap, at)
    globalThis.postMessage({ id, frame }, { transfer: [frame.thumbnail.buffer] })
  }
  catch (error) {
    globalThis.postMessage({ id, error: errorMessageFrom(error) ?? 'The frame encoder failed.' })
  }
})
