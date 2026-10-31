/**
 * How the MMD scene shades its materials.
 *
 * - `toon`: the MMD toon materials, as before.
 * - `hybrid`: physically based materials, but faces and eyes stay toon. Anime face normals are made for toon shading.
 * - `pbr`: physically based materials everywhere.
 */
export type MMDRenderMode = 'toon' | 'hybrid' | 'pbr'

/** The kind of surface that a material shows. It decides the default PBR values. */
export type MMDSurfaceKind = 'face' | 'eye' | 'skin' | 'hair' | 'cloth' | 'fur' | 'leather' | 'metal' | 'other'

export const MMD_SURFACE_KINDS: readonly MMDSurfaceKind[] = ['face', 'eye', 'skin', 'hair', 'cloth', 'fur', 'leather', 'metal', 'other']

/** PBR values of one material. */
export interface MMDSurfaceValues {
  roughness: number
  metalness: number
  /** Soft cloth sheen, 0 to 1. */
  sheen: number
  /** A clear glossy coat, for example latex, 0 to 1. */
  clearcoat: number
}

/** The owner's changes to one material: another kind, or other values. */
export type MMDSurfaceOverride = Partial<MMDSurfaceValues> & { kind?: MMDSurfaceKind }

/** A material after classification and the owner's changes. */
export interface MMDSurface extends MMDSurfaceValues {
  kind: MMDSurfaceKind
}

export const MMD_SURFACE_DEFAULTS: Record<MMDSurfaceKind, MMDSurfaceValues> = {
  face: { roughness: 0.6, metalness: 0, sheen: 0, clearcoat: 0 },
  eye: { roughness: 0.2, metalness: 0, sheen: 0, clearcoat: 0.6 },
  skin: { roughness: 0.65, metalness: 0, sheen: 0.2, clearcoat: 0 },
  hair: { roughness: 0.45, metalness: 0, sheen: 0.4, clearcoat: 0 },
  cloth: { roughness: 0.8, metalness: 0, sheen: 0.6, clearcoat: 0 },
  fur: { roughness: 0.95, metalness: 0, sheen: 1, clearcoat: 0 },
  leather: { roughness: 0.35, metalness: 0, sheen: 0, clearcoat: 0.8 },
  metal: { roughness: 0.3, metalness: 1, sheen: 0, clearcoat: 0 },
  other: { roughness: 0.6, metalness: 0, sheen: 0, clearcoat: 0 },
}

/** What tells the kind of a material. */
export interface MMDMaterialHints {
  name: string
  /** Many PMD models name a material after its texture file, for example `kami.bmp` for hair. */
  textureFileName?: string
  /** The share of the material's vertices, 0 to 1, that mainly follow the head bone `頭`. */
  headShare?: number
}

/**
 * A material that mostly follows the head bone is the face, unless its name says hair or eyes. Face skin in PMD models
 * often has no name, or the name of a shared texture such as `huku3w.bmp`. Things worn on the head, such as a hat,
 * also become the face, so they keep the toon look.
 */
const FACE_HEAD_SHARE = 0.5

/**
 * Words in material names, first match wins. Eyes come before faces, because names like `目` and `顔` both appear on
 * face parts.
 *
 * - Japanese words match anywhere in the name.
 * - Latin words, English or romaji, match at the start of a word. For example, `huku3.bmp` is clothes.
 */
const KIND_KEYWORDS: ReadonlyArray<[MMDSurfaceKind, readonly string[]]> = [
  ['eye', ['目', '瞳', '眼', 'まつ毛', 'まつげ', '睫', 'ハイライト', 'eye', 'iris', 'pupil', 'lash', 'me', 'hitomi', 'matsuge', 'shirome']],
  ['face', ['顔', '眉', 'まゆ', '口', '歯', '舌', '頬', 'ほほ', '表情', 'face', 'brow', 'mouth', 'teeth', 'tooth', 'tongue', 'cheek', 'kao', 'mayu', 'kuchi', 'hoho']],
  ['hair', ['髪', 'ヘア', 'もみあげ', 'ツインテ', 'hair', 'bang', 'kami']],
  ['fur', ['ファー', '毛皮', 'もこもこ', 'fur', 'fluff']],
  ['leather', ['革', 'レザー', 'ラテックス', 'ゴム', 'エナメル', '手袋', 'グローブ', 'leather', 'latex', 'rubber', 'glove', 'enamel']],
  ['metal', ['金属', 'メタル', '金具', 'ボタン', '鎖', 'metal', 'chain', 'buckle', 'zipper', 'kinzoku']],
  ['skin', ['肌', '体', '腕', '脚', '足', '手', '首', 'skin', 'body', 'arm', 'leg', 'hand', 'neck', 'hada']],
  ['cloth', ['服', '衣', 'スカート', 'シャツ', '袖', 'ネクタイ', 'リボン', '靴下', 'ニーソ', 'タイツ', 'スカーフ', '帽', 'ドレス', 'セーラー', '制服', 'cloth', 'skirt', 'shirt', 'sleeve', 'tie', 'ribbon', 'sock', 'dress', 'coat', 'jacket', 'hat', 'huku', 'fuku']],
]

/**
 * Whether a Latin keyword starts a word. A short keyword must end the word or meet a digit, so `me` matches `me.bmp`
 * but not `metal`. A longer keyword can start a longer word, so `hair` matches `hairband`.
 */
function startsWord(words: readonly string[], keyword: string): boolean {
  return words.some(word => word.startsWith(keyword)
    && (keyword.length >= 4 || word.length === keyword.length || /\d/.test(word[keyword.length])))
}

function kindOf(text: string): MMDSurfaceKind | undefined {
  // NFKC folds half-width katakana and full-width Latin letters, so both spellings match.
  const folded = text.normalize('NFKC').toLowerCase()
  const words = folded.split(/[^a-z0-9]+/)
  for (const [kind, keywords] of KIND_KEYWORDS) {
    if (keywords.some(keyword => /^[a-z]/.test(keyword) ? startsWord(words, keyword) : folded.includes(keyword)))
      return kind
  }
  return undefined
}

/**
 * Guesses the kind of a material from its name, then from its texture file name. A material that mostly follows the
 * head bone is the face, unless it is hair or eyes. Any other material without a known word is `other`.
 *
 * @example
 * classifyMMDMaterial({ name: '前髪' }) // => 'hair'
 * classifyMMDMaterial({ name: 'ｽｶｰﾄ' }) // => 'cloth'
 * classifyMMDMaterial({ name: '', textureFileName: 'kami.bmp' }) // => 'hair'
 * classifyMMDMaterial({ name: 'huku3w.bmp', headShare: 1 }) // => 'face'
 */
export function classifyMMDMaterial(material: MMDMaterialHints): MMDSurfaceKind {
  const kind = kindOf(material.name) ?? kindOf(material.textureFileName ?? '') ?? 'other'
  if (kind !== 'hair' && kind !== 'eye' && (material.headShare ?? 0) > FACE_HEAD_SHARE)
    return 'face'
  return kind
}

/** The kind and PBR values of a material: its guessed kind and that kind's defaults, under the owner's changes. */
export function resolveMMDSurface(material: MMDMaterialHints, override: MMDSurfaceOverride = {}): MMDSurface {
  return applyMMDSurfaceOverride(classifyMMDMaterial(material), override)
}

/** The kind and PBR values of a material whose kind is already guessed, under the owner's changes. */
export function applyMMDSurfaceOverride(guessedKind: MMDSurfaceKind, override: MMDSurfaceOverride = {}): MMDSurface {
  const kind = override.kind ?? guessedKind
  return { ...MMD_SURFACE_DEFAULTS[kind], ...stripKind(override), kind }
}

/** Whether a material of this kind renders physically based in this mode. */
export function usesPhysicalMaterial(mode: MMDRenderMode, kind: MMDSurfaceKind): boolean {
  if (mode === 'toon')
    return false
  if (mode === 'pbr')
    return true
  return kind !== 'face' && kind !== 'eye'
}

function stripKind(override: MMDSurfaceOverride): Partial<MMDSurfaceValues> {
  const { kind: _kind, ...values } = override
  return values
}
