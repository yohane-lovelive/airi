import type { DisplayModel } from '@proj-airi/stage-ui/stores/display-models'

function inferModelFileName(model: DisplayModel) {
  if (model.type === 'file')
    return model.file.name

  try {
    const url = new URL(model.url)
    const parsedName = url.pathname.split('/').pop()
    if (parsedName)
      return parsedName
  }
  catch {}

  return `${model.id}.vrm`
}

async function readModelData(model: DisplayModel) {
  if (model.type === 'file')
    return new Uint8Array(await model.file.arrayBuffer())

  const response = await fetch(model.url)
  if (!response.ok)
    throw new Error(`Failed to fetch model asset (${response.status} ${response.statusText})`)

  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Reads the bytes of a display model for a display sidecar, which reads the model from disk.
 *
 * Use when:
 * - A renderer is about to send the selected model to Electron main.
 */
export async function readDisplayModelFile(model: DisplayModel) {
  return {
    fileName: inferModelFileName(model),
    data: await readModelData(model),
  }
}
