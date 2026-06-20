import { SHADER_CUBES_WORDS_PER_FACE } from '../wasm-mesher/bridge/shaderCubeBridge'
import { WORD0 } from './shaders/cubeBlockShader'

export type ShaderSectionRaycastBox = {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
  cx: number
  cy: number
  cz: number
}

export type ShaderSectionRaycastEntry = {
  box: ShaderSectionRaycastBox
  sectionCenterX: number
  sectionCenterY: number
  sectionCenterZ: number
}

/**
 * Tight world-space AABB covering occupied shader-cube blocks in a section.
 * `sectionCenter*` is geometryData.sx/sy/sz (section base + 8).
 */
export function computeShaderSectionRaycastAabb(
  words: Uint32Array,
  faceCount: number,
  sectionCenterX: number,
  sectionCenterY: number,
  sectionCenterZ: number
): ShaderSectionRaycastBox | undefined {
  if (faceCount <= 0) return undefined

  const baseX = sectionCenterX - 8
  const baseY = sectionCenterY - 8
  const baseZ = sectionCenterZ - 8
  const stride = SHADER_CUBES_WORDS_PER_FACE

  let minLx = 16
  let minLy = 16
  let minLz = 16
  let maxLx = -1
  let maxLy = -1
  let maxLz = -1

  for (let i = 0; i < faceCount; i++) {
    const w0 = words[i * stride]!
    const lx = w0 & ((1 << WORD0.LX_BITS) - 1)
    const ly = (w0 >> WORD0.LY_SHIFT) & ((1 << WORD0.LY_BITS) - 1)
    const lz = (w0 >> WORD0.LZ_SHIFT) & ((1 << WORD0.LZ_BITS) - 1)
    if (lx < minLx) minLx = lx
    if (ly < minLy) minLy = ly
    if (lz < minLz) minLz = lz
    if (lx > maxLx) maxLx = lx
    if (ly > maxLy) maxLy = ly
    if (lz > maxLz) maxLz = lz
  }

  if (maxLx < 0) return undefined

  const minX = baseX + minLx
  const minY = baseY + minLy
  const minZ = baseZ + minLz
  const maxX = baseX + maxLx + 1
  const maxY = baseY + maxLy + 1
  const maxZ = baseZ + maxLz + 1

  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    cx: (minX + maxX) * 0.5,
    cy: (minY + maxY) * 0.5,
    cz: (minZ + maxZ) * 0.5
  }
}

export function isPointInsideAabb(
  ox: number,
  oy: number,
  oz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number
): boolean {
  return ox >= minX && ox <= maxX && oy >= minY && oy <= maxY && oz >= minZ && oz <= maxZ
}

/** True if a `far`-bounded ray from (ox,oy,oz) dir (dx,dy,dz) crosses or starts inside
 *  the cube-section AABB centered at (cx,cy,cz) with the given half-extent. */
export function sectionAabbIntersectsRay(
  cx: number,
  cy: number,
  cz: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  far: number,
  halfExtent: number
): boolean {
  const minX = cx - halfExtent
  const minY = cy - halfExtent
  const minZ = cz - halfExtent
  const maxX = cx + halfExtent
  const maxY = cy + halfExtent
  const maxZ = cz + halfExtent
  if (isPointInsideAabb(ox, oy, oz, minX, minY, minZ, maxX, maxY, maxZ)) return true
  return raycastAabb(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ, far) !== undefined
}

/** Ray–AABB entry distance, or undefined. Ignores hits when origin is inside the box. */
export function raycastAabb(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  maxDist: number
): number | undefined {
  if (isPointInsideAabb(ox, oy, oz, minX, minY, minZ, maxX, maxY, maxZ)) {
    return undefined
  }

  let tmin = 0
  let tmax = maxDist

  if (Math.abs(dx) < 1e-8) {
    if (ox < minX || ox > maxX) return undefined
  } else {
    const inv = 1 / dx
    let t1 = (minX - ox) * inv
    let t2 = (maxX - ox) * inv
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
    }
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return undefined
  }

  if (Math.abs(dy) < 1e-8) {
    if (oy < minY || oy > maxY) return undefined
  } else {
    const inv = 1 / dy
    let t1 = (minY - oy) * inv
    let t2 = (maxY - oy) * inv
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
    }
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return undefined
  }

  if (Math.abs(dz) < 1e-8) {
    if (oz < minZ || oz > maxZ) return undefined
  } else {
    const inv = 1 / dz
    let t1 = (minZ - oz) * inv
    let t2 = (maxZ - oz) * inv
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
    }
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return undefined
  }

  return tmin <= tmax && tmin >= 0 ? tmin : undefined
}

/** Ray origin inside AABB: distance to exit face along the ray. */
export function raycastAabbFromInside(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  maxDist: number
): number | undefined {
  let tExit = maxDist

  if (Math.abs(dx) >= 1e-8) {
    const t = dx > 0 ? (maxX - ox) / dx : (minX - ox) / dx
    if (t > 1e-6) tExit = Math.min(tExit, t)
  } else if (ox < minX || ox > maxX) return undefined

  if (Math.abs(dy) >= 1e-8) {
    const t = dy > 0 ? (maxY - oy) / dy : (minY - oy) / dy
    if (t > 1e-6) tExit = Math.min(tExit, t)
  } else if (oy < minY || oy > maxY) return undefined

  if (Math.abs(dz) >= 1e-8) {
    const t = dz > 0 ? (maxZ - oz) / dz : (minZ - oz) / dz
    if (t > 1e-6) tExit = Math.min(tExit, t)
  } else if (oz < minZ || oz > maxZ) return undefined

  return tExit <= maxDist ? tExit : undefined
}

/** Per-block raycast; `word0Stride` 1 = GlobalBlockBuffer SoA, 4 = deferred AoS. */
export function raycastShaderBlocksAabb(
  w0Source: Uint32Array,
  start: number,
  faceCount: number,
  word0Stride: number,
  sectionCenterX: number,
  sectionCenterY: number,
  sectionCenterZ: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  visitGen: Uint16Array,
  visitStamp: number
): number | undefined {
  const baseX = sectionCenterX - 8
  const baseY = sectionCenterY - 8
  const baseZ = sectionCenterZ - 8

  let closest = maxDist
  let found = false

  for (let i = 0; i < faceCount; i++) {
    const w0 = w0Source[start + i * word0Stride]!
    const lx = w0 & ((1 << WORD0.LX_BITS) - 1)
    const ly = (w0 >> WORD0.LY_SHIFT) & ((1 << WORD0.LY_BITS) - 1)
    const lz = (w0 >> WORD0.LZ_SHIFT) & ((1 << WORD0.LZ_BITS) - 1)
    const visitIdx = lx + (ly << 4) + (lz << 8)
    if (visitGen[visitIdx] === visitStamp) continue
    visitGen[visitIdx] = visitStamp

    const minX = baseX + lx
    const minY = baseY + ly
    const minZ = baseZ + lz
    const maxX = minX + 1
    const maxY = minY + 1
    const maxZ = minZ + 1

    let t: number | undefined
    if (isPointInsideAabb(ox, oy, oz, minX, minY, minZ, maxX, maxY, maxZ)) {
      t = raycastAabbFromInside(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ, closest)
    } else {
      t = raycastAabb(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ, closest)
    }
    if (t !== undefined && t < closest) {
      closest = t
      found = true
    }
  }

  return found ? closest : undefined
}

/** 16³ section box centered at (cx, cy, cz) — tests / legacy helper. */
export function raycastSectionAabb(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  maxDist: number
): number | undefined {
  return raycastAabb(ox, oy, oz, dx, dy, dz, cx - 8, cy - 8, cz - 8, cx + 8, cy + 8, cz + 8, maxDist)
}
