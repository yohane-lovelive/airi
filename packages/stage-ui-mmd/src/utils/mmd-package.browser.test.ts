import JSZip from 'jszip'

import { describe, expect, it } from 'vitest'

import { entriesFromFolder, entriesFromZip, packMMDModel, variantsOf } from './mmd-package'
import { decodeZipFileName } from './mmd-zip-loader'

/** `結月.bmp` in Shift_JIS, as older Windows and Japanese tools write ZIP names. */
const SHIFT_JIS_NAME = new Uint8Array([0x8C, 0x8B, 0x8C, 0x8E, 0x2E, 0x62, 0x6D, 0x70])

function folderFile(path: string, content = path) {
  const file = new File([content], path.slice(path.lastIndexOf('/') + 1))
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}

describe('decodeZipFileName', () => {
  it('reads a name that is not valid UTF-8 as Shift_JIS', () => {
    expect(decodeZipFileName(SHIFT_JIS_NAME)).toBe('結月.bmp')
  })

  it('keeps a valid UTF-8 name and accepts the string form of JSZip', () => {
    expect(decodeZipFileName(new TextEncoder().encode('結月.bmp'))).toBe('結月.bmp')
    expect(decodeZipFileName(['a', '.', 'p', 'm', 'x'])).toBe('a.pmx')
  })
})

describe('entriesFromZip', () => {
  // ROOT CAUSE:
  //
  // Older Windows writes Japanese ZIP names in Shift_JIS without the UTF-8 flag. JSZip read them as UTF-8, so model
  // names showed U+FFFD characters.
  //
  // We fixed this by reading such names as Shift_JIS when they are not valid UTF-8.
  it('reads Shift_JIS names of a ZIP without the UTF-8 flag', async () => {
    const zip = new JSZip()
    zip.file('model.pmd', 'model')
    zip.file('texture.bmp', 'texture')
    // JSZip writes the returned string as raw bytes, one byte for each character.
    const archive = await zip.generateAsync({
      type: 'blob',
      encodeFileName: name => name === 'texture.bmp' ? String.fromCharCode(...SHIFT_JIS_NAME) : name,
    })

    const entries = await entriesFromZip(archive)

    expect(entries.map(entry => entry.path).sort()).toEqual(['model.pmd', '結月.bmp'])
  })
})

describe('entriesFromFolder', () => {
  it('drops the picked folder from each path', () => {
    const entries = entriesFromFolder([folderFile('Miku/Miku.pmx'), folderFile('Miku/tex/face.png')])

    expect(entries.map(entry => entry.path)).toEqual(['Miku.pmx', 'tex/face.png'])
  })
})

describe('packMMDModel', () => {
  const entries = entriesFromFolder([
    folderFile('Lat/Lat_White.pmd'),
    folderFile('Lat/Lat_Normal.pmd'),
    folderFile('Lat/tex/face.bmp'),
    folderFile('Lat/readme.txt'),
  ])

  it('lists the models of a package in path order', () => {
    expect(variantsOf(entries).map(variant => variant.name)).toEqual(['Lat_Normal', 'Lat_White'])
  })

  it('packs the chosen model with every file that is not a model', async () => {
    const [normal] = variantsOf(entries)

    const file = await packMMDModel(entries, normal)
    const packed = await JSZip.loadAsync(await file.arrayBuffer())

    expect(file.name).toBe('Lat_Normal.zip')
    expect(Object.keys(packed.files).sort()).toEqual(['Lat_Normal.pmd', 'readme.txt', 'tex/', 'tex/face.bmp'])
    expect(await packed.file('Lat_Normal.pmd')!.async('string')).toBe('Lat/Lat_Normal.pmd')
  })

  it('refuses a model that is not in the package', async () => {
    await expect(packMMDModel(entries, { name: 'x', modelPath: 'x.pmx', format: 'pmx' })).rejects.toThrow('no model file')
  })
})
