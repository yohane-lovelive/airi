import { Buffer } from 'node:buffer'

import { ResizeFit, Transformer } from '@napi-rs/image'
import { contactSheetLayout } from '@proj-airi/stage-shared/perception'

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
