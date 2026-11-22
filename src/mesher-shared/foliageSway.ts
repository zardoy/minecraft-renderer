/**
 * Waving foliage: which legacy (non-cube) vertices sway and how the shader learns about it.
 *
 * Legacy geometry has no free attribute for this, so the mesher tags swaying vertices by nudging
 * their tile-local UV a tiny bit towards the face centre. The nudge is 1/2048 of the face
 * (1/128 texel of a 16px tile, 1/2048 of a block on screen), invisible with nearest sampling, but the
 * vertex shader sees an atlas coordinate that is no longer on the texel grid. Vertices that are not
 * tagged stay exactly on the grid, so untouched geometry decodes as "does not sway".
 *
 * Levels: 0 = anchored, 1 = top of a plant (or the bottom of the upper half of a tall plant), 2 = top of a tall
 * plant. v carries "level >= 1", u carries "level >= 2". The tag is always written so turning the option on or off
 * needs no remesh. See FOLIAGE_SWAY_GLSL for the decoder.
 */

/** Nudge in face-local UV units (the face spans 0..1). */
export const FOLIAGE_UV_TAG = 1 / 2048
/** Off-grid distance in texels the shader accepts as a tag (16px tile: 0.0078, 128px tile: 0.0625). */
export const FOLIAGE_TAG_MIN_TEXELS = 0.003
export const FOLIAGE_TAG_MAX_TEXELS = 0.1

/** Two block tall plants: the upper half continues the sway of the lower half. */
const TALL_PLANTS = new Set(['tall_grass', 'large_fern', 'sunflower', 'lilac', 'rose_bush', 'peony', 'pitcher_plant', 'double_plant'])

const SINGLE_PLANTS = new Set([
  // 1.13+ (`grass` is the plant before 1.20.3, the grass block is `grass_block`)
  'short_grass',
  'grass',
  'fern',
  'dead_bush',
  'dandelion',
  'poppy',
  'blue_orchid',
  'allium',
  'azure_bluet',
  'red_tulip',
  'orange_tulip',
  'white_tulip',
  'pink_tulip',
  'oxeye_daisy',
  'cornflower',
  'lily_of_the_valley',
  'wither_rose',
  'torchflower',
  'open_eyeblossom',
  'closed_eyeblossom',
  'bush',
  'firefly_bush',
  'short_dry_grass',
  'tall_dry_grass',
  'wheat',
  'carrots',
  'potatoes',
  'beetroots',
  'sweet_berry_bush',
  // pre-1.13 names
  'tallgrass',
  'deadbush',
  'yellow_flower',
  'red_flower',
  'sapling'
])

/**
 * -1: does not sway, 0: anchored at its own bottom, 1: upper half of a tall plant (its bottom already sways).
 * Full cubes never sway here: leaves go through the shader cube path, and pre-1.13 `grass` is the grass block.
 */
export function foliageSwayBase(blockName: string, blockProps: Record<string, unknown> | undefined, isCube: boolean): number {
  if (isCube || !isFoliageBlockName(blockName)) return -1
  return TALL_PLANTS.has(blockName) && blockProps?.half === 'upper' ? 1 : 0
}

/** Cheap name-only check, lets callers skip resolving block properties for everything else. */
export function isFoliageBlockName(blockName: string): boolean {
  return TALL_PLANTS.has(blockName) || SINGLE_PLANTS.has(blockName) || blockName.endsWith('_sapling')
}

/** Level of one vertex. `blockLocalY` is the vertex height inside its block (0 = bottom, 1 = top). */
export function foliageSwayLevel(base: number, blockLocalY: number): number {
  if (base < 0) return 0
  return base + (blockLocalY > 0.5 ? 1 : 0)
}

const towardsCentre = (t: number) => (t < 0.5 ? t + FOLIAGE_UV_TAG : t - FOLIAGE_UV_TAG)

/** Face-local UV (each 0..1, before scaling to the atlas) with the tag for `level` applied. */
export function tagFoliageUv(baseU: number, baseV: number, level: number): [number, number] {
  if (level <= 0) return [baseU, baseV]
  return [level >= 2 ? towardsCentre(baseU) : baseU, towardsCentre(baseV)]
}

/** CPU mirror of the shader decoder, for tests. `uv` in atlas units, `atlasSize` in pixels. */
export function decodeFoliageSwayLevel(u: number, v: number, atlasWidth: number, atlasHeight: number): number {
  const tagged = (coord: number, size: number) => {
    const texels = coord * size
    const offGrid = Math.abs(texels - Math.round(texels))
    return offGrid > FOLIAGE_TAG_MIN_TEXELS && offGrid < FOLIAGE_TAG_MAX_TEXELS
  }
  if (!tagged(v, atlasHeight)) return 0
  return tagged(u, atlasWidth) ? 2 : 1
}
