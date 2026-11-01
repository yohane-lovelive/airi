import type { CapturedFrame } from './frame-ring'

import { contactSheetLayout } from '@proj-airi/stage-shared/perception'

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

/**
 * Scales a JPEG down to `maxLongSide` pixels on its long side. A smaller image passes as it is.
 * A decision turn sends older frames smaller than the newest one.
 */
export async function scaleImage(image: Blob, maxLongSide: number): Promise<Blob> {
  const bitmap = await createImageBitmap(image)
  try {
    const scale = maxLongSide / Math.max(bitmap.width, bitmap.height)
    if (scale >= 1)
      return image
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: FRAME_LIMITS.jpegQuality })
  }
  finally {
    bitmap.close()
  }
}

/**
 * Cuts one box out of a JPEG and scales it down to `maxLongSide` pixels on its long side. The box holds shares of the
 * width and the height. A watch check sends this crop, not the whole frame.
 */
export async function cropImage(image: Blob, box: { x: number, y: number, width: number, height: number }, maxLongSide: number): Promise<Blob> {
  const bitmap = await createImageBitmap(image)
  try {
    const sx = Math.round(box.x * bitmap.width)
    const sy = Math.round(box.y * bitmap.height)
    const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(box.width * bitmap.width)))
    const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(box.height * bitmap.height)))
    const scale = Math.min(1, maxLongSide / Math.max(sw, sh))
    const width = Math.max(1, Math.round(sw * scale))
    const height = Math.max(1, Math.round(sh * scale))
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height)
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: FRAME_LIMITS.jpegQuality })
  }
  finally {
    bitmap.close()
  }
}

/**
 * Draws up to six frames as tiles of one JPEG, left to right and top to bottom, oldest first. The `contact-sheet` frame
 * policy sends it as one image.
 */
export async function renderContactSheet(images: readonly Blob[]): Promise<Blob> {
  const layout = contactSheetLayout(images.length)
  const canvas = new OffscreenCanvas(layout.width, layout.height)
  const context = canvas.getContext('2d')!
  context.fillStyle = '#000000'
  context.fillRect(0, 0, layout.width, layout.height)
  for (const [index, tile] of layout.tiles.entries()) {
    const bitmap = await createImageBitmap(images[index])
    try {
      context.drawImage(bitmap, tile.x, tile.y, tile.width, tile.height)
    }
    finally {
      bitmap.close()
    }
  }
  return canvas.convertToBlob({ type: 'image/jpeg', quality: FRAME_LIMITS.jpegQuality })
}
