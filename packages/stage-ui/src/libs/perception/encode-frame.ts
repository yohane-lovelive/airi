import type { CapturedFrame } from './frame-ring'

import { FRAME_LIMITS } from './frame-ring'

/**
 * Turns one bitmap into a captured frame: a scaled JPEG and a small grayscale thumbnail. It closes the bitmap.
 * It runs in the frame encoder worker, and on the page where no worker exists.
 */
export async function encodeFrame(bitmap: ImageBitmap, at: number): Promise<CapturedFrame> {
  try {
    const scale = Math.min(1, FRAME_LIMITS.maxLongSide / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
    const image = await canvas.convertToBlob({ type: 'image/jpeg', quality: FRAME_LIMITS.jpegQuality })

    const { thumbnailWidth, thumbnailHeight } = FRAME_LIMITS
    const small = new OffscreenCanvas(thumbnailWidth, thumbnailHeight)
    const context = small.getContext('2d', { willReadFrequently: true })!
    context.drawImage(bitmap, 0, 0, thumbnailWidth, thumbnailHeight)
    const { data } = context.getImageData(0, 0, thumbnailWidth, thumbnailHeight)
    const thumbnail = new Uint8Array(thumbnailWidth * thumbnailHeight)
    for (let index = 0; index < thumbnail.length; index++) {
      const offset = index * 4
      // The Rec. 601 weights give the brightness that the eye sees.
      thumbnail[index] = Math.round(0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2])
    }
    return { at, image, width, height, thumbnail }
  }
  finally {
    bitmap.close()
  }
}
