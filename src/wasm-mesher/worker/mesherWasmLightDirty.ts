import { SECTION_HEIGHT } from '../../mesher-shared/shared'

/** Section Y values to dirty for a column after `update_light` updates the light cache. */
export function sectionYsForLightColumnDirty(worldMinY: number, worldMaxY: number, sectionHeight = SECTION_HEIGHT): number[] {
  const ys: number[] = []
  for (let y = worldMinY; y < worldMaxY; y += sectionHeight) {
    ys.push(y)
  }
  return ys
}
