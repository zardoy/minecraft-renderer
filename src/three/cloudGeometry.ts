/** Which cells of vanilla clouds.png hold cloud (the texture wraps in both directions). */
export interface CloudCover {
  width: number
  height: number
  /** Row-major, 1 where the cell has a cloud. */
  filled: Uint8Array
}

export interface CloudGeometryData {
  positions: Float32Array
  /** Per-vertex face brightness. */
  shades: Float32Array
  indices: Uint32Array
}

/** Vanilla: each clouds.png texel is a 12×12 block cell and the slab is 4 blocks thick. */
export const CLOUD_CELL_SIZE = 12
export const CLOUD_THICKNESS = 4

// Vanilla fancy-cloud face shading.
const SHADE_TOP = 1
const SHADE_BOTTOM = 0.7
const SHADE_NORTH_SOUTH = 0.8
const SHADE_EAST_WEST = 0.9

const mod = (n: number, m: number) => ((n % m) + m) % m

/**
 * Builds the slab geometry for the (2 * radius + 1)² cells around pattern cell (centerX, centerZ).
 * Positions are relative to that cell's min corner, y spans 0..CLOUD_THICKNESS. Side faces are only
 * emitted next to empty cells, so the interior of a cloud bank has no hidden geometry.
 * Every quad is wound counter-clockwise seen from outside.
 */
export function buildCloudGeometry(cover: CloudCover, centerX: number, centerZ: number, radius: number): CloudGeometryData {
  const positions: number[] = []
  const shades: number[] = []
  const indices: number[] = []

  const isFilled = (cellX: number, cellZ: number) => cover.filled[mod(cellZ, cover.height) * cover.width + mod(cellX, cover.width)] === 1

  const quad = (shade: number, a: number[], b: number[], c: number[], d: number[]) => {
    const first = positions.length / 3
    positions.push(...a, ...b, ...c, ...d)
    shades.push(shade, shade, shade, shade)
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3)
  }

  const h = CLOUD_THICKNESS
  for (let i = -radius; i <= radius; i++) {
    for (let j = -radius; j <= radius; j++) {
      const cellX = centerX + i
      const cellZ = centerZ + j
      if (!isFilled(cellX, cellZ)) continue

      const x0 = i * CLOUD_CELL_SIZE
      const x1 = x0 + CLOUD_CELL_SIZE
      const z0 = j * CLOUD_CELL_SIZE
      const z1 = z0 + CLOUD_CELL_SIZE

      quad(SHADE_TOP, [x0, h, z0], [x0, h, z1], [x1, h, z1], [x1, h, z0])
      quad(SHADE_BOTTOM, [x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1])
      if (!isFilled(cellX + 1, cellZ)) quad(SHADE_EAST_WEST, [x1, 0, z0], [x1, h, z0], [x1, h, z1], [x1, 0, z1])
      if (!isFilled(cellX - 1, cellZ)) quad(SHADE_EAST_WEST, [x0, 0, z1], [x0, h, z1], [x0, h, z0], [x0, 0, z0])
      if (!isFilled(cellX, cellZ + 1)) quad(SHADE_NORTH_SOUTH, [x1, 0, z1], [x1, h, z1], [x0, h, z1], [x0, 0, z1])
      if (!isFilled(cellX, cellZ - 1)) quad(SHADE_NORTH_SOUTH, [x0, 0, z0], [x0, h, z0], [x1, h, z0], [x1, 0, z0])
    }
  }

  return { positions: new Float32Array(positions), shades: new Float32Array(shades), indices: new Uint32Array(indices) }
}
