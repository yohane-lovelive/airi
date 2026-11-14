import type { DisplayModel } from '@proj-airi/stage-ui/stores/display-models'

import { entriesFromZip } from '@proj-airi/stage-ui-mmd/utils/mmd-package'
import { detectMMDVariants } from '@proj-airi/stage-ui-mmd/utils/mmd-zip-loader'

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

/**
 * Unpacks an MMD package of the display models for a display sidecar. The names of old packages are Shift_JIS, and
 * `entriesFromZip` decodes them.
 *
 * The package gives the model that the three.js stage shows: the first model file of the package. An import with a
 * choice keeps only the chosen model, so a stored package normally has one.
 *
 * @returns the files, or undefined when the first model is not a PMX file, for example a PMD file.
 */
export async function readPmxPackage(model: DisplayModel) {
  const entries = await entriesFromZip(new Blob([await readModelData(model)]))
  const variant = detectMMDVariants(entries.map(entry => entry.path))[0]
  if (variant?.format !== 'pmx')
    return undefined

  return {
    modelPath: variant.modelPath,
    files: await Promise.all(entries.map(async entry => ({
      path: entry.path,
      data: new Uint8Array(await entry.data.arrayBuffer()),
    }))),
  }
}
