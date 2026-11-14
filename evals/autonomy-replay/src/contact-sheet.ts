import { Buffer } from 'node:buffer'

import { ResizeFit, Transformer } from '@napi-rs/image'
import { contactSheetLayout } from '@proj-airi/stage-shared/perception'

/**
 * Scales a JPEG down to `maxLongSide` pixels on its long side. A smaller image passes as it is.
 * The app sends the older frames of a turn smaller than the newest one. Takes and resolves to base64.
 */
export async function scaleFrame(image: string, maxLongSide: number): Promise<string> {
  const source = Buffer.from(image, 'base64')
  const { width, height } = await new Transformer(source).metadata()
  const scale = maxLongSide / Math.max(width, height)
  if (scale >= 1)
    return image
  return (await new Transformer(source).resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), null, ResizeFit.Fill).jpeg(75)).toString('base64')
}

/**
 * Tiles up to six JPEG frames into one JPEG, as the app does with OffscreenCanvas: left to right and top to bottom,
 * oldest first, on a black sheet. Resolves to the JPEG as base64.
 */
export async function renderContactSheet(images: readonly string[]): Promise<string> {
  const layout = contactSheetLayout(images.length)
  // A black, opaque sheet: every fourth byte is the alpha of a pixel.
  const pixels = new Uint8Array(layout.width * layout.height * 4)
  for (let index = 3; index < pixels.length; index += 4)
    pixels[index] = 255
  const sheet = Transformer.fromRgbaPixels(pixels, layout.width, layout.height)
  for (const [index, tile] of layout.tiles.entries()) {
    const resized = await new Transformer(Buffer.from(images[index], 'base64')).resize(tile.width, tile.height, null, ResizeFit.Fill).png()
    sheet.overlay(resized, tile.x, tile.y)
  }
  return (await sheet.jpeg(75)).toString('base64')
}
