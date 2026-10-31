import type { MMDModelVariant } from './mmd-zip-loader'

import JSZip from 'jszip'

import { decodeZipFileName, detectMMDVariants } from './mmd-zip-loader'

/** One file of an MMD model package, by its path inside the package. */
export interface MMDPackageEntry {
  path: string
  data: Blob
}

/**
 * Lists the files of a folder that the user picked.
 *
 * The browser gives each file its path from the picked folder, for example `Miku/tex/face.png`. The first segment is
 * the picked folder itself, so it is dropped.
 */
export function entriesFromFolder(files: Iterable<File>): MMDPackageEntry[] {
  return Array.from(files, (file) => {
    const path = (file.webkitRelativePath || file.name).replace(/\\/g, '/')
    const slash = path.indexOf('/')
    return { path: slash === -1 ? path : path.slice(slash + 1), data: file }
  })
}

/** Reads every file of a ZIP. Names without the UTF-8 flag go through {@link decodeZipFileName}. */
export async function entriesFromZip(file: Blob): Promise<MMDPackageEntry[]> {
  const archive = await new JSZip().loadAsync(file, { decodeFileName: decodeZipFileName })
  const files = Object.values(archive.files).filter(entry => !entry.dir)
  return Promise.all(files.map(async entry => ({ path: entry.name, data: await entry.async('blob') })))
}

/** The model files of a package, in path order, so a list of choices stays stable. */
export function variantsOf(entries: MMDPackageEntry[]): MMDModelVariant[] {
  return detectMMDVariants(entries.map(entry => entry.path)).sort((left, right) => left.modelPath.localeCompare(right.modelPath))
}

/**
 * Packs one model of a package into a ZIP that the MMD loader reads.
 *
 * The ZIP holds the chosen model file and every file that is not a model, so each package with several models gives
 * one model for each choice. JSZip writes UTF-8 names with the UTF-8 flag, so Japanese names stay readable.
 *
 * @returns A file named after the model, for example `Miku.zip`.
 */
export async function packMMDModel(entries: MMDPackageEntry[], variant: MMDModelVariant): Promise<File> {
  const modelPaths = new Set(variantsOf(entries).map(item => item.modelPath))
  if (!modelPaths.has(variant.modelPath))
    throw new Error(`The package has no model file at ${variant.modelPath}`)

  const zip = new JSZip()
  for (const entry of entries) {
    if (entry.path === variant.modelPath || !modelPaths.has(entry.path))
      zip.file(entry.path, entry.data)
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  return new File([blob], `${variant.name}.zip`, { type: 'application/zip' })
}
