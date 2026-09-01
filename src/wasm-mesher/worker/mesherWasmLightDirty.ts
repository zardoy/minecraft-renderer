import { SECTION_HEIGHT } from '../../mesher-shared/shared'

/** Section Y values to dirty for a column after `update_light` updates the light cache. */
export function sectionYsForLightColumnDirty(worldMinY: number, worldMaxY: number, sectionHeight = SECTION_HEIGHT): number[] {
  const ys: number[] = []
  for (let y = worldMinY; y < worldMaxY; y += sectionHeight) {
    ys.push(y)
  }
  return ys
}

/**
 * 1.18+ fused meshing prefers the original raw map_chunk. A later light-only
 * column reload must drop that entry so the JSON column walk is used.
 * Normal chunk loads must keep it (`setRawMapChunk` arrives first).
 */
export function dropRawMapChunkOnLightOnlyReload(
  isLightUpdate: boolean | undefined,
  rawCache: { delete: (key: string) => boolean },
  key: string
): boolean {
  if (!isLightUpdate) return false
  return rawCache.delete(key)
}
