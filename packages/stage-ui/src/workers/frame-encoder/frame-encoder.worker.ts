import { errorMessageFrom } from '@moeru/std'

import { encodeFrame, encodeScreenFrame } from '../../libs/perception/encode-frame'

/**
 * Encodes each bitmap that the page sends, and answers under the same id. A `screen` request gives a JPEG for the screen
 * of a sidecar room, and any other request gives a frame of perception.
 */
globalThis.addEventListener('message', async (event: MessageEvent<{ id: number, bitmap: ImageBitmap, at: number, kind?: 'screen' }>) => {
  const { id, bitmap, at, kind } = event.data
  try {
    if (kind === 'screen') {
      globalThis.postMessage({ id, image: await encodeScreenFrame(bitmap) })
      return
    }
    const frame = await encodeFrame(bitmap, at)
    globalThis.postMessage({ id, frame }, { transfer: [frame.thumbnail.buffer] })
  }
  catch (error) {
    globalThis.postMessage({ id, error: errorMessageFrom(error) ?? 'The frame encoder failed.' })
  }
})
