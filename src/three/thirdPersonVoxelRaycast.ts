import { raycastAabb, raycastAabbFromInside } from './sectionRaycastAabb'

export type VoxelRaycastHit = {
  distance: number
  blockX: number
  blockY: number
  blockZ: number
}

const intBound = (s: number, ds: number): number => {
  if (ds === 0) return Infinity
  if (ds < 0) return intBound(-s, -ds)
  const frac = s - Math.floor(s)
  return (1 - frac) / ds
}

const hitSolidBlock = (
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  bx: number,
  by: number,
  bz: number,
  maxDist: number,
  radius: number,
  minCameraDistance: number
): number | undefined => {
  const minX = bx - radius
  const minY = by - radius
  const minZ = bz - radius
  const maxX = bx + 1 + radius
  const maxY = by + 1 + radius
  const maxZ = bz + 1 + radius

  let t = raycastAabb(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ, maxDist)
  if (t === undefined) {
    t = raycastAabbFromInside(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ, maxDist)
  }
  if (t === undefined) return undefined
  return Math.max(minCameraDistance, t)
}

/**
 * Amanatides–Woo grid traversal against solid block volumes (not rendered mesh faces).
 * `radius` is baked into per-block AABB expansion (swept sphere).
 */
export function raycastVoxelSolid(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  radius: number,
  minCameraDistance: number,
  isSolid: (x: number, y: number, z: number) => boolean
): VoxelRaycastHit | undefined {
  if (maxDist <= 0) return undefined

  let x = Math.floor(ox)
  let y = Math.floor(oy)
  let z = Math.floor(oz)

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0

  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity

  let tMaxX = stepX !== 0 ? intBound(ox, dx) : Infinity
  let tMaxY = stepY !== 0 ? intBound(oy, dy) : Infinity
  let tMaxZ = stepZ !== 0 ? intBound(oz, dz) : Infinity

  const tryHit = (bx: number, by: number, bz: number): VoxelRaycastHit | undefined => {
    if (!isSolid(bx, by, bz)) return undefined
    const distance = hitSolidBlock(ox, oy, oz, dx, dy, dz, bx, by, bz, maxDist, radius, minCameraDistance)
    if (distance === undefined || distance > maxDist) return undefined
    return { distance, blockX: bx, blockY: by, blockZ: bz }
  }

  let hit = tryHit(x, y, z)
  if (hit) return hit

  let t = 0
  while (t <= maxDist) {
    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) {
        x += stepX
        t = tMaxX
        tMaxX += tDeltaX
      } else {
        z += stepZ
        t = tMaxZ
        tMaxZ += tDeltaZ
      }
    } else if (tMaxY < tMaxZ) {
      y += stepY
      t = tMaxY
      tMaxY += tDeltaY
    } else {
      z += stepZ
      t = tMaxZ
      tMaxZ += tDeltaZ
    }

    if (t > maxDist) break

    hit = tryHit(x, y, z)
    if (hit) return hit
  }

  return undefined
}
