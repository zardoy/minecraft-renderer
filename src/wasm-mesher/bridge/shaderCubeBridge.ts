/**
 * Pack visible WASM block faces into GPU-instanced shader words (4×Uint32 per face).
 * Each emitted instance becomes one face quad on the shader-cube mesh; the legacy
 * vertex path is bypassed for blocks that pass {@link isShaderCubeBlock}.
 */

import blocksAtlasesJson from 'mc-assets/dist/blocksAtlases.json'
import { WORD0, WORD1, WORD2, WORD3 } from '../../three/shaders/cubeBlockShader'
import { TextureIndexMapping, type TextureEntry } from '../../three/shaders/textureIndexMapping'
import { TintPalette } from '../../three/shaders/tintPalette'

export const SHADER_CUBES_FORMAT_VERSION = 3 as const
export const SHADER_CUBES_WORDS_PER_FACE = 4 as const

export type ShaderCubesOutput = {
  words: Uint32Array
  /** Number of visible faces (= instances × 1; each instance is one face) */
  count: number
  formatVersion: typeof SHADER_CUBES_FORMAT_VERSION
}

const CARDINAL_FACE_NAMES = ['up', 'down', 'east', 'west', 'south', 'north'] as const
const WASM_FACE_ORDER = CARDINAL_FACE_NAMES
const FACE_NAME_TO_INDEX: Record<string, number> = {
  up: 0,
  down: 1,
  east: 2,
  west: 3,
  south: 4,
  north: 5,
}

/**
 * WASM/elemFaces corner order → shader vi corner order (BASE/DU/DV in cubeBlockShader).
 * UP/DOWN/EAST/WEST match 1:1; NORTH/SOUTH need a 180° corner rotation because their
 * BASE origin is on the opposite side of the quad.
 */
export const AO_LIGHT_REMAP: readonly (readonly number[])[] = [
  [0, 1, 2, 3], // UP
  [0, 1, 2, 3], // DOWN
  [0, 1, 2, 3], // EAST
  [0, 1, 2, 3], // WEST
  [2, 3, 0, 1], // SOUTH
  [2, 3, 0, 1], // NORTH
] as const

/** Reorder per-corner AO or light values for shader-space corners. */
export function remapCornersForShaderFace(
  faceIdx: number,
  values: number[],
  fallback: number,
): number[] {
  const map = AO_LIGHT_REMAP[faceIdx] ?? AO_LIGHT_REMAP[0]
  return map.map((i) => values[i] ?? fallback)
}

export interface ShaderCubeBlockInput {
  position: [number, number, number]
  visible_faces: number
  ao_data: number[][]
  /** @deprecated combined f32; prefer sky_light_data + block_light_data or light_combined */
  light_data?: number[][]
  sky_light_data?: number[][]
  block_light_data?: number[][]
  /** Per-corner nibble-packed byte: high=sky4, low=block4 */
  light_combined?: number[][]
}

export interface ShaderCubeModelInput {
  blockName: string
  blockProps: Record<string, any>
  isCube: boolean
  /** Resolved variant `models[variantIndex][0]` */
  model: {
    x?: number
    y?: number
    z?: number
    elements?: Array<{
      rotation?: { axis: string, angle: number, origin: number[] }
      faces?: Record<string, { texture?: TextureEntry & { rotation?: number }, tintindex?: number }>
    }>
  }
}

let tintPalette: TintPalette | null = null
let textureIndexMapping: TextureIndexMapping | null = null
let tintsMissingWarned = false

/** Convert mc-assets texture scales (normalized or negative) to pixel tile size for index lookup. */
function normalizeTextureEntryForTileIndex(
  tex: { u?: number, v?: number, su?: number, sv?: number },
  atlasWidth: number,
  tileSize: number,
): TextureEntry {
  let u = tex.u ?? 0
  let v = tex.v ?? 0
  let su = tex.su ?? tileSize
  let sv = tex.sv ?? tileSize
  if (u > 0 && u <= 1) u = Math.round(u * atlasWidth)
  if (v > 0 && v <= 1) v = Math.round(v * atlasWidth)
  if (Math.abs(su) > 0 && Math.abs(su) <= 1) su = Math.round(Math.abs(su) * atlasWidth) || tileSize
  else if (su < 0) su = tileSize
  if (Math.abs(sv) > 0 && Math.abs(sv) <= 1) sv = Math.round(Math.abs(sv) * atlasWidth) || tileSize
  else if (sv < 0) sv = tileSize
  return { u, v, su, sv }
}

type FaceTextureRef = TextureEntry & { tileIndex?: number }

/** Prefer atlas `tileIndex` from block model (legacy path uses the same). */
export function resolveFaceTileIndex(
  tex: FaceTextureRef,
  texMapping: TextureIndexMapping,
): number {
  const fromAtlas = tex.tileIndex
  // tile 0 is a special/atlas-padding slot; use pixel fallback for block faces
  if (typeof fromAtlas === 'number' && fromAtlas > 0 && fromAtlas < 4096) {
    return fromAtlas
  }
  const entry = normalizeTextureEntryForTileIndex(
    tex,
    texMapping.getTilesPerRow() * 16,
    16,
  )
  return texMapping.tileIndexFromTextureEntry(entry)
}

/** Main thread + worker: use `loadedData` set by the app / mesher (see mesherWasm). */
function getTintsJson(): Record<string, any> | null {
  const tints = (globalThis as any).loadedData?.tints
  if (!tints) {
    if (!tintsMissingWarned) {
      tintsMissingWarned = true
      console.warn('[shaderCubeBridge] loadedData.tints missing; shader cubes use legacy path')
    }
    return null
  }
  return tints
}

export function getShaderCubeResources(): {
  tintPalette: TintPalette
  textureIndexMapping: TextureIndexMapping
} | null {
  const tintsData = getTintsJson()
  if (!tintsData) {
    return null
  }
  if (!tintPalette) {
    tintPalette = TintPalette.fromTintsData(tintsData)
    tintPalette.createTexture()
  }
  if (!textureIndexMapping) {
    const latest = (blocksAtlasesJson as any).latest ?? (blocksAtlasesJson as any)
    textureIndexMapping = new TextureIndexMapping({
      width: latest.width,
      height: latest.height,
      tileSize: latest.tileSize ?? 16,
      suSv: latest.suSv ?? 16,
      textures: latest.textures ?? {},
    })
  }
  return { tintPalette, textureIndexMapping }
}

/** Reset cached palette/atlas (tests). */
export function resetShaderCubeResources(): void {
  tintPalette = null
  textureIndexMapping = null
  tintsMissingWarned = false
}

/**
 * Returns true when the block is a plain 1×1×1 cube that the instanced shader path
 * can render exactly like the legacy mesher (no model rotation, single un-rotated
 * element with all 6 cardinal faces present, atlas matches shader gate).
 * Pass the already-resolved model variant (`modelVars[variantIndex][0]`).
 */
export function isShaderCubeBlock(
  cached: ShaderCubeModelInput & { isCube: boolean },
  model: ShaderCubeModelInput['model'],
  sectionHeight: number,
  texMapping: TextureIndexMapping,
): boolean {
  if (sectionHeight !== 16) return false
  if (!cached.isCube) return false
  if (!texMapping.isValid()) return false

  for (const axis of ['x', 'y', 'z'] as const) {
    if (model[axis]) return false
  }

  const elements = model.elements ?? []
  if (elements.length !== 1) return false
  const element = elements[0]
  if (element.rotation) return false

  const faces = element.faces
  if (!faces) return false

  for (const faceName of CARDINAL_FACE_NAMES) {
    const eFace = faces[faceName]
    if (!eFace) return false
    // Shader UV table is hardcoded per-face; arbitrary per-face UV rotation forces legacy.
    if ((eFace as { rotation?: number }).rotation) return false
    const tex = eFace.texture
    if (!tex) return false
    if (resolveFaceTileIndex(tex as FaceTextureRef, texMapping) < 0) {
      return false
    }
  }

  return true
}

function packWord0(
  lx: number,
  ly: number,
  lz: number,
  faceId: number,
  tintIndex: number,
  ao: number[],
): number {
  let w = 0
  w |= (lx & 0xf) << WORD0.LX_SHIFT
  w |= (ly & 0xf) << WORD0.LY_SHIFT
  w |= (lz & 0xf) << WORD0.LZ_SHIFT
  w |= (faceId & 7) << WORD0.FACE_SHIFT
  w |= (tintIndex & 0xff) << WORD0.TINT_SHIFT
  for (let i = 0; i < WORD0.NUM_CORNERS; i++) {
    w |= ((ao[i] ?? 3) & 3) << (WORD0.AO_SHIFT + i * WORD0.AO_BITS_PER_CORNER)
  }
  return w >>> 0
}

function packWord1(lightCombined: number[]): number {
  let w = 0
  for (let i = 0; i < WORD1.NUM_CORNERS; i++) {
    w |= ((lightCombined[i] ?? 255) & 0xff) << (i * WORD1.LIGHT_BITS_PER_CORNER)
  }
  return w >>> 0
}

function biasedSectionIndex(sectionBaseCoord: number): number {
  return (Math.floor(sectionBaseCoord / 16) + WORD3.SECTION_BIAS) & WORD3.SECTION_MASK
}

export function packWord2(
  texIndex: number,
  aoDiagonalFlip: boolean,
  sectionBaseX: number,
  sectionBaseY: number,
  sectionBaseZ: number,
): number {
  let w = texIndex & ((1 << WORD2.TEX_INDEX_BITS) - 1)
  if (aoDiagonalFlip) {
    w |= 1 << WORD2.DIAGONAL_FLAG_SHIFT
  }
  const sectionY = ((Math.floor(sectionBaseY / 16) + 4) & 0x1f) << WORD2.SECTION_Y_SHIFT
  w |= sectionY
  const sx = biasedSectionIndex(sectionBaseX)
  const sz = biasedSectionIndex(sectionBaseZ)
  w |= ((sx >>> 16) & 0x3f) << WORD2.SECTION_X_HI_SHIFT
  w |= ((sz >>> 16) & 0x3f) << WORD2.SECTION_Z_HI_SHIFT
  return w >>> 0
}

export function packWord3(sectionBaseX: number, sectionBaseZ: number): number {
  const sx = biasedSectionIndex(sectionBaseX)
  const sz = biasedSectionIndex(sectionBaseZ)
  return ((sx & 0xffff) | ((sz & 0xffff) << 16)) >>> 0
}

/** Decode section base block coords from packed words (round-trip helper for tests). */
export function decodeSectionBaseFromWords(word2: number, word3: number): { x: number, y: number, z: number } {
  const sX = ((word3 & 0xffff) | (((word2 >>> WORD2.SECTION_X_HI_SHIFT) & 0x3f) << 16)) - WORD3.SECTION_BIAS
  const sZ = (((word3 >>> 16) & 0xffff) | (((word2 >>> WORD2.SECTION_Z_HI_SHIFT) & 0x3f) << 16)) - WORD3.SECTION_BIAS
  const sY = ((word2 >>> WORD2.SECTION_Y_SHIFT) & ((1 << WORD2.SECTION_Y_BITS) - 1)) - 4
  return { x: sX * 16, y: sY * 16, z: sZ * 16 }
}

/** EMPTY sentinel for a freed global-buffer instance slot. */
export function packWord2Empty(): number {
  return (1 << WORD2.EMPTY_SHIFT) >>> 0
}

/** 12-bit texture tile index from packed word2. */
export function unpackTexIndexFromWord2(word2: number): number {
  return word2 & ((1 << WORD2.TEX_INDEX_BITS) - 1)
}

function packCornerLightByte (skyNorm: number, blockNorm: number): number {
  const sky4 = Math.min(15, Math.round(Math.max(0, skyNorm) * 15))
  const block4 = Math.min(15, Math.round(Math.max(0, blockNorm) * 15))
  return ((sky4 << 4) | block4) & 0xff
}

function lightCombinedForFace(
  block: ShaderCubeBlockInput,
  faceDataIndex: number,
): number[] {
  const packed = block.light_combined?.[faceDataIndex]
  if (packed && packed.length === 4) {
    return packed
  }
  const sky = block.sky_light_data?.[faceDataIndex]
  const blockL = block.block_light_data?.[faceDataIndex]
  if (sky && blockL && sky.length === 4 && blockL.length === 4) {
    return sky.map((s, i) => packCornerLightByte(s ?? 1, blockL[i] ?? 0))
  }
  const floats = block.light_data?.[faceDataIndex] ?? [1, 1, 1, 1]
  return floats.map((f) => packCornerLightByte(f, 0))
}

function buildWasmFaceToDataIndex(visibleFaces: number): Record<number, number> {
  const map: Record<number, number> = {}
  let dataIndex = 0
  for (const faceName of WASM_FACE_ORDER) {
    const faceIdx = FACE_NAME_TO_INDEX[faceName]
    if ((visibleFaces & (1 << faceIdx)) !== 0) {
      map[faceIdx] = dataIndex++
    }
  }
  return map
}

export type BuildShaderCubeInstancesOpts = {
  sectionOrigin: { x: number, y: number, z: number }
  sectionHeight: number
  biome?: string
  tintPalette: TintPalette
  textureIndexMapping: TextureIndexMapping
  /**
   * When false (blocks with model.ao === false), emit full-bright faces without AO
   * diagonal flip — matches legacy render-from-wasm path.
   */
  doAO?: boolean
}

/**
 * Pack all visible faces of one block into `words` (4 uints per face).
 * Returns false if the block must use the legacy vertex path.
 */
export function tryBuildShaderCubeInstances(
  block: ShaderCubeBlockInput,
  cached: ShaderCubeModelInput & { isCube: boolean },
  model: ShaderCubeModelInput['model'],
  opts: BuildShaderCubeInstancesOpts,
  words: number[],
): boolean {
  const {
    sectionOrigin,
    sectionHeight,
    biome,
    tintPalette,
    textureIndexMapping,
    doAO = true,
  } = opts

  if (!isShaderCubeBlock(cached, model, sectionHeight, textureIndexMapping)) {
    return false
  }

  const element = model.elements![0]
  const faces = element.faces!
  const wasmFaceToDataIndex = buildWasmFaceToDataIndex(block.visible_faces)
  const [bx, by, bz] = block.position
  const lx = bx & 15
  const ly = (by - sectionOrigin.y) & 15
  const lz = bz & 15

  const wordsStart = words.length

  for (const faceName of WASM_FACE_ORDER) {
    const faceIdx = FACE_NAME_TO_INDEX[faceName]
    if ((block.visible_faces & (1 << faceIdx)) === 0) continue

    const faceDataIndex = wasmFaceToDataIndex[faceIdx]
    if (faceDataIndex === undefined) continue

    const eFace = faces[faceName]
    const tex = eFace.texture! as FaceTextureRef
    const texIndex = resolveFaceTileIndex(tex, textureIndexMapping)
    if (texIndex < 0) {
      words.length = wordsStart
      return false
    }

    const rawAo = block.ao_data[faceDataIndex] ?? [3, 3, 3, 3]
    const rawLight = lightCombinedForFace(block, faceDataIndex)

    let ao: number[]
    let lightCombined: number[]
    let aoDiagonalFlip: boolean

    if (doAO) {
      ao = remapCornersForShaderFace(faceIdx, rawAo, 3)
      lightCombined = remapCornersForShaderFace(faceIdx, rawLight, 255)
      aoDiagonalFlip = ao[0] + ao[3] >= ao[1] + ao[2]
    } else {
      ao = [3, 3, 3, 3]
      lightCombined = [255, 255, 255, 255]
      aoDiagonalFlip = false
    }

    const tintIndex = tintPalette.getTintIndex(
      eFace.tintindex,
      cached.blockName,
      cached.blockProps,
      biome ?? 'plains',
    )

    words.push(
      packWord0(lx, ly, lz, faceIdx, tintIndex, ao),
      packWord1(lightCombined),
      packWord2(texIndex, aoDiagonalFlip, sectionOrigin.x, sectionOrigin.y, sectionOrigin.z),
      packWord3(sectionOrigin.x, sectionOrigin.z),
    )

  }

  return true
}

export function buildShaderCubesFromWords(wordQuads: number[]): ShaderCubesOutput | undefined {
  const faceCount = Math.floor(wordQuads.length / SHADER_CUBES_WORDS_PER_FACE)
  if (faceCount === 0) return undefined
  return {
    words: new Uint32Array(wordQuads),
    count: faceCount,
    formatVersion: SHADER_CUBES_FORMAT_VERSION,
  }
}

/** Visible face count from WASM bitmask */
export function countVisibleFaces(visibleFaces: number): number {
  let n = 0
  for (let i = 0; i < 6; i++) {
    if (visibleFaces & (1 << i)) n++
  }
  return n
}
